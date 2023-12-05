const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const url = require('url');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const clients = new Map();
const wsConnections = new Map();
const OCPPResponseMap = new Map();

const dbUrl = 'mongodb://127.0.0.1:27017/';
const dbName = 'ev';
const collectionName = 'ev_details';

const client = new MongoClient(dbUrl);
client.connect();

startWebSocket();

app.server = server;
app.use((req, res, next) => {
    req.wss = wss;
    next();
});

const getUniqueIdentifierFromRequest = (request) => {
    return request.url.split('/').pop();
};

const handleWebSocketUpgrade = (request, socket, head) => {
    const uniqueIdentifier = getUniqueIdentifierFromRequest(request);

    if (!uniqueIdentifier) {
        console.error('WebSocket upgrade failed due to missing unique identifier.');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, async(ws) => {
        wsConnections.set(uniqueIdentifier, ws);
        wss.emit('connection', ws, request);
    });
};

function reconnectWebSocket() {
    startWebSocket();
}

function startWebSocket() {
    wss.on('connection', async(ws, req) => {
        try {
            const clientIpAddress = req.connection.remoteAddress;
            const uniqueIdentifier = getUniqueIdentifierFromRequest(req);
            console.log(`WebSocket Connected to ${uniqueIdentifier}`);
            wsConnections.set(uniqueIdentifier, ws);

            const db = client.db(dbName);
            const query = { yourField: uniqueIdentifier };
            const updateOperation = { $set: { ip: clientIpAddress } };

            await db.collection('ev_details')
                .updateOne(query, updateOperation)
                .then(result => {
                    console.log(`Matched ${result.matchedCount} document(s) and modified ${result.modifiedCount} document(s)`);
                })
                .catch(err => {
                    console.error('Error updating document:', err);
                });

            await db.collection('ev_charger_status').updateOne({ chargerID: uniqueIdentifier }, { $set: { clientIP: clientIpAddress } }, function(err, result) {
                if (err) throw err;
                console.log(`Matched ${result.matchedCount} document(s) and modified ${result.modifiedCount} document(s)`);
            });

            clients.set(ws, clientIpAddress);

            ws.on('message', async(message) => {
                const currentDate = new Date();
                const formattedDate = currentDate.toISOString();

                if (typeof message === 'object') {
                    try {
                        const requestData = JSON.parse(message);

                        console.log(`Received message from DeviceID ${uniqueIdentifier}: ${message}`);

                        const parsedMessage = JSON.parse(message);

                        if (requestData[0] === 3 && requestData[2].status === 'Accepted') {
                            const status = "Action Initiated";
                            await StartStopStatus(uniqueIdentifier, status);
                        }

                        if (requestData[0] === 3 && requestData[2].action === 'DataTransfer') {
                            const httpResponse = OCPPResponseMap.get(ws);
                            if (httpResponse) {
                                httpResponse.setHeader('Content-Type', 'application/json');
                                httpResponse.end(JSON.stringify(parsedMessage));
                                OCPPResponseMap.delete(ws);
                            }
                        }

                        if (requestData[0] === 3 && requestData[2].configurationKey) {
                            const httpResponse = OCPPResponseMap.get(ws);
                            if (httpResponse) {
                                httpResponse.setHeader('Content-Type', 'application/json');
                                httpResponse.end(JSON.stringify(parsedMessage));
                                OCPPResponseMap.delete(ws);
                            }
                        }

                        if (requestData[0] === 2 && requestData[2] === 'FirmwareStatusNotification') {
                            const httpResponse = OCPPResponseMap.get(ws);
                            if (httpResponse) {
                                httpResponse.setHeader('Content-Type', 'application/json');
                                httpResponse.end(JSON.stringify(parsedMessage));
                                OCPPResponseMap.delete(ws);
                            }
                        }

                        if (Array.isArray(requestData) && requestData.length >= 4) {
                            const requestType = requestData[0];
                            const Identifier = requestData[1];
                            const requestName = requestData[2];

                            if (requestType === 2 && requestName === "BootNotification") {
                                console.log(`Received BootNotification request with unique identifier: ${Identifier}`);
                                const response = [3, Identifier, {
                                    "status": "Accepted",
                                    "currentTime": new Date().toISOString(),
                                    "interval": 14400
                                }];
                                ws.send(JSON.stringify(response));
                            } else if (requestType === 2 && requestName === "StatusNotification") {
                                const response = [3, "a6gs8797ewYM06", {}];
                                ws.send(JSON.stringify(response));
                                const status = parsedMessage[3].status;
                                const errorCode = parsedMessage[3].errorCode;
                                const timestamp = parsedMessage[3].timestamp;
                                if (status != undefined) {
                                    const keyValPair = {};
                                    keyValPair.status = status;
                                    keyValPair.timestamp = timestamp;
                                    keyValPair.clientIP = clientIpAddress;
                                    keyValPair.errorCode = errorCode;
                                    const Chargerstatus = JSON.stringify(keyValPair);
                                    await SaveChargerStatus(Chargerstatus);
                                }
                            } else if (requestType === 2 && requestName === "Heartbeat") {
                                const response = [3, "a6gs8797ewYM03", { "currentTime": formattedDate }];
                                ws.send(JSON.stringify(response));
                                await updateTime(uniqueIdentifier);
                            } else if (requestType === 2 && requestName === "Authorize") {
                                const response = [3, Identifier, { "idTagInfo": { "status": "Accepted", "parentIdTag": "B4A63CDB" } }];
                                ws.send(JSON.stringify(response));
                                const status = "Access Granted";
                                await StartStopStatus(uniqueIdentifier, status);
                            } else if (requestType === 2 && requestName === "StartTransaction") {
                                let transId;
                                await db.collection('ev_details').findOne({ ip: clientIpAddress })
                                    .then(transData => {
                                        if (transData) {
                                            transId = transData.transactionId;
                                            const response = [3, Identifier, { "transactionId": transId, "idTagInfo": { "status": "Accepted", "parentIdTag": "B4A63CDB" } }];
                                            ws.send(JSON.stringify(response));
                                        } else {
                                            console.log('Transaction ID not set or not available !');
                                        }
                                    })
                                    .catch(error => {
                                        console.error('Error executing findOne:', error);
                                    });
                            } else if (requestType === 2 && requestName === "MeterValues") {
                                const response = [3, Identifier, {}];
                                ws.send(JSON.stringify(response));
                                const meterValueArray = parsedMessage[3].meterValue[0].sampledValue;
                                const keyValuePair = {};
                                meterValueArray.forEach((sampledValue) => {
                                    const measurand = sampledValue.measurand;
                                    const value = sampledValue.value;
                                    keyValuePair[measurand] = value;
                                });
                                keyValuePair.clientIP = clientIpAddress;
                                const ChargerValue = JSON.stringify(keyValuePair);
                                await SaveChargerValue(ChargerValue);
                                await updateTime(uniqueIdentifier);
                                const stat = 'Charging';
                                await StartStopStatus(uniqueIdentifier, stat);
                            } else if (requestType === 2 && requestName === "StopTransaction") {
                                const response = [3, Identifier, {}];
                                ws.send(JSON.stringify(response));
                                const status = "Finishing";
                                await StartStopStatus(uniqueIdentifier, status);
                            }
                        }
                    } catch (error) {
                        console.error('Error parsing or processing the message:', error);
                    }
                }
            });

            ws.on('close', (code, reason) => {
                console.log(`WebSocket closed with code ${code} and reason: ${reason}`);
                reconnectWebSocket();
                console.log("reconnect - close");
            });

            ws.on('error', (error) => {
                console.error(`WebSocket error: ${error.message}`);
            });

        } catch (error) {
            console.error('Error in WebSocket server setup:', error);
            // Attempt to reconnect
            reconnectWebSocket();
            console.log("reconnect - server setup");
        }
    });
}

app.get('/checkDeviceID', (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const queryParams = parsedUrl.query;
    const chargerID = queryParams.chargerID;

    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    collection.findOne({ yourField: chargerID })
        .then(result => {
            if (result) {

                const valueCollection = db.collection('ev_charger_values');
                const statusCollection = db.collection('ev_charger_status');

                valueCollection.find({ chargerID }).toArray()
                    .then(valueData => {

                        const latestValueData = valueData[valueData.length - 1];

                        statusCollection.find({ chargerID }).toArray()
                            .then(statusData => {
                                const responseData = {
                                    valueData: latestValueData,
                                    statusData: statusData,
                                };

                                res.setHeader('Content-Type', 'application/json');
                                res.end(JSON.stringify(responseData));
                            })
                            .catch(error => {
                                res.setHeader('Content-Type', 'application/json');
                                res.end(JSON.stringify({ error: error }));
                            });
                    })
                    .catch(error => {
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ error: error }));
                    });
            } else {
                res.end("DeviceNotAvailable");
            }
        })
        .catch(error => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error }));
        });
});

app.get('/start', (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const queryParams = parsedUrl.query;
    const id = queryParams.id;

    const deviceIDToSendTo = id; // Specify the device ID you want to send the message to
    const wsToSendTo = wsConnections.get(deviceIDToSendTo);

    if (wsToSendTo) {
        const remoteStartRequest = [2, "1695798668459", "RemoteStartTransaction", {
            "connectorId": 1,
            "idTag": "B4A63CDB",
            "timestamp": new Date().toISOString(),
            "meterStart": 0,
            "reservationId": 0
        }];

        wsToSendTo.send(JSON.stringify(remoteStartRequest));
        // OK status
        console.log('Message sent to the WebSocket client for device ID:', deviceIDToSendTo);
        res.statusCode = 200;
        res.end('Message sent to the WebSocket client for device ID: ' + deviceIDToSendTo);
    } else {
        // Charger ID Not Found/Available
        console.log('WebSocket client not found for the specified device ID:', deviceIDToSendTo);
        res.statusCode = 404;
        res.end('WebSocket client not found for the specified device ID: ' + deviceIDToSendTo);
    }
});

app.get('/SendOCPPRequest', (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const queryParams = parsedUrl.query;
    const id = queryParams.id;
    const payload = JSON.parse(queryParams.req);
    const action = queryParams.actionBtn;

    const deviceIDToSendTo = id; // Specify the device ID you want to send the message to
    const wsToSendTo = wsConnections.get(deviceIDToSendTo);
    let ReqMsg = "";

    if (wsToSendTo) {

        switch (action) {

            case "GetConfiguration":
                ReqMsg = [2, "1701682466389", "GetConfiguration", payload];
                break;
            case "DataTransfer":
                ReqMsg = [2, "1701682577685", "DataTransfer", payload];
                break;
            case "UpdateFirmware":
                ReqMsg = [2, "1701682616338", "UpdateFirmware", payload];
                break;

        }

        // Map the WebSocket connection to the HTTP response
        OCPPResponseMap.set(wsToSendTo, res);
        wsToSendTo.send(JSON.stringify(ReqMsg));

        console.log('Message sent to the OCPP Request client for device ID:', deviceIDToSendTo);

    } else {
        // Charger ID Not Found/Available
        console.log('OCPP Request client not found for the specified device ID:', deviceIDToSendTo);
        res.status(404).end('OCPP Request client not found for the specified device ID: ' + deviceIDToSendTo);
    }
});

app.get('/stop', (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const queryParams = parsedUrl.query;
    const id = queryParams.id;

    // Specify the device ID you want to send the message to
    const deviceIDToSendTo = id;

    client.db(dbName).collection('ev_details').findOne({ yourField: deviceIDToSendTo })
        .then(transData => {
            if (transData) {
                const wsToSendTo = wsConnections.get(deviceIDToSendTo);
                if (wsToSendTo) {
                    const transId = transData.transactionId;
                    const remoteStopRequest = [2, "1695798668459", "RemoteStopTransaction", { "transactionId": transId }];
                    wsToSendTo.send(JSON.stringify(remoteStopRequest));

                    // OK status
                    console.log('Message sent to the WebSocket client for device ID:', deviceIDToSendTo);
                    res.statusCode = 200;
                    res.end('Message sent to the WebSocket client for device ID: ' + deviceIDToSendTo);
                } else {
                    console.log('WebSocket client not found for the specified device ID:', deviceIDToSendTo);
                    res.statusCode = 404;
                    res.end('WebSocket client not found for the specified device ID: ' + deviceIDToSendTo);
                }
            } else {
                console.log('Transaction ID not set or not available !');
            }
        })
        .catch(error => {
            console.log('Transaction ID not set or not available!');
            res.statusCode = 400;
            res.end('Transaction ID not set or not available for the specified device ID: ' + deviceIDToSendTo);
        });
});

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Set up a route for the root URL
app.get('/ODTCharger', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/GetAction', async(req, res) => {

    try {
        const db = client.db(dbName);
        const collection = db.collection('ocpp_actions');

        const Data = await collection.find({}).toArray();

        // Map the database documents into the desired format
        const ResponseVal = Data.map(item => {
            return {
                action: item.action,
                payload: JSON.parse(item.payload)
            };
        });

        res.json(ResponseVal);
    } catch (error) {
        console.log("Error form GetAction - ", error);
    }

})

app.get('*', (req, res) => {
    res.status(404).send('Invalid Request');
});

server.on('upgrade', async(request, socket, head) => {
    try {
        const uniqueIdentifier = getUniqueIdentifierFromRequest(request);

        if (!uniqueIdentifier) {
            console.error('WebSocket upgrade failed due to missing unique identifier.');
            socket.destroy();
            return;
        }

        if (await shouldUpgradeForDevice(uniqueIdentifier)) {
            handleWebSocketUpgrade(request, socket, head);
        } else {
            console.log('WebSocket upgrade not allowed for the specified device:', uniqueIdentifier);
            socket.destroy();
        }
    } catch (error) {
        console.error('Error handling WebSocket upgrade:', error);
        socket.destroy();
    }
});

async function shouldUpgradeForDevice(uniqueIdentifier) {
    try {
        const db = client.db(dbName);
        const collection = db.collection('ev_details');

        const device = await collection.findOne({ yourField: uniqueIdentifier });

        return !!device; // Returns true if the device is found, false otherwise
    } catch (error) {
        console.error('Error checking device existence:', error);
        return false;
    }
}

async function StartStopStatus(ChargerID, Status) {

    const db = client.db(dbName);
    const collection = db.collection('ev_charger_status');

    const filter = { chargerID: ChargerID };
    const update = { $set: { status: Status } };
    const result = await collection.updateOne(filter, update);

    if (result.acknowledged === true) {
        console.log(`Successfully updated start/stop status for charger with ID ${ChargerID}`);
    } else {
        console.log(`Charger with ID ${ChargerID} not found`);
    }
}

async function SaveChargerStatus(chargerStatus) {

    const db = client.db(dbName);
    const collection = db.collection('ev_charger_status');
    const ChargerStatus = JSON.parse(chargerStatus);
    // Check if a document with the same chargerID already exists
    await collection.findOne({ clientIP: ChargerStatus.clientIP })
        .then(existingDocument => {
            if (existingDocument) {
                // Update the existing document
                collection.updateOne({ clientIP: ChargerStatus.clientIP }, { $set: { status: ChargerStatus.status, timestamp: ChargerStatus.timestamp, errorCode: ChargerStatus.errorCode } })
                    .then(result => {
                        if (result) {
                            console.log('Status updated');
                        } else {
                            console.log('Status not updated');
                        }
                    })
                    .catch(error => {
                        console.log(error);
                    });


            } else {

                db.collection('ev_details').findOne({ ip: ChargerStatus.clientIP })
                    .then(foundDocument => {
                        if (foundDocument) {
                            ChargerStatus.chargerID = foundDocument.yourField;

                            collection.insertOne(ChargerStatus)
                                .then(result => {
                                    if (result) {
                                        console.log('Status inserted');
                                    } else {
                                        console.log('Status not inserted');
                                    }
                                })
                                .catch(error => {
                                    console.log(error);
                                });

                        } else {
                            console.log('Document not found');
                        }
                    })
            }
        })
        .catch(error => {
            console.log(error);
        });
}

async function SaveChargerValue(ChargerVal) {


    const db = client.db(dbName);
    const collection = db.collection('ev_charger_values');
    const ChargerValue = JSON.parse(ChargerVal);

    await db.collection('ev_details').findOne({ ip: ChargerValue.clientIP })
        .then(foundDocument => {
            if (foundDocument) {
                ChargerValue.chargerID = foundDocument.yourField; // Assuming yourField is the correct field name
                collection.insertOne(ChargerValue)
                    .then(result => {
                        if (result) {
                            console.log('value inserted');
                        } else {
                            console.log('value not inserted');
                        }
                    })
                    .catch(error => {
                        console.log(error);
                    });
            } else {
                console.log('Value not available');
                return Promise.resolve(null);
            }
        })

}

async function updateTime(Device_ID) {

    const db = client.db(dbName);
    const collection = db.collection('ev_charger_status');

    const filter = { chargerID: Device_ID };
    const update = { $set: { timestamp: new Date() } };

    const result = await collection.updateOne(filter, update);

    if (result.modifiedCount === 1) {
        console.log(`Successfully updated time for charger with ID ${Device_ID}`);
    } else {
        console.log(`Charger with ID ${Device_ID} not found`);
    }
}

server.listen(8050, () => {
    console.log('Server is running on port 8050');
});