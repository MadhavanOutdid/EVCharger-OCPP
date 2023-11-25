const http = require('http');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const url = require('url');

const wss = new WebSocket.Server({ noServer: true });
const deviceToWebSocketMap = new Map();
// Data structure to store source IP addresses
const clients = new Map();

const dbUrl = 'mongodb://127.0.0.1:27017/';
const dbName = 'ev';
const collectionName = 'ev_details';

const client = new MongoClient(dbUrl);
client.connect();

global.RECEIVED_ID = '';

async function connectWebSocket(ws) {
    try {
        console.log('WebSocket connected');

        const client = await MongoClient.connect(dbUrl);
        console.log('Connected to MongoDB');

        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        const deviceDocs = await collection.find({}).toArray();
        deviceDocs.forEach((deviceDoc) => {
            const deviceID = '/OCPPJ/' + deviceDoc.yourField;
            deviceToWebSocketMap.set(deviceID, ws);
        });

        console.log('WebSocket clients stored in map for all devices');
    } catch (err) {
        console.error('Error connecting to MongoDB or fetching data:', err);
    }
}

// Create an HTTP server
const server = http.createServer((req, res) => {

    if (req.method === 'GET' && req.url.startsWith('/checkDeviceID')) {

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



    } else if (req.method === 'GET' && req.url.startsWith('/start')) {

        const parsedUrl = url.parse(req.url, true);
        const queryParams = parsedUrl.query;
        const id = queryParams.id;

        const deviceIDToSendTo = '/OCPPJ/' + id; // Specify the device ID you want to send the message to
        const wsToSendTo = deviceToWebSocketMap.get(deviceIDToSendTo);
        //console.log(wsToSendTo);

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

    } else if (req.method === 'GET' && req.url.startsWith('/stop')) {

        const parsedUrl = url.parse(req.url, true);
        const queryParams = parsedUrl.query;
        const id = queryParams.id;

        const deviceIDToSendTo = '/OCPPJ/' + id; // Specify the device ID you want to send the message to
        const wsToSendTo = deviceToWebSocketMap.get(deviceIDToSendTo);

        if (wsToSendTo) {
            const remoteStopRequest = [2, "1695798668459", "RemoteStopTransaction", { "transactionId": 1027020 }];
            wsToSendTo.send(JSON.stringify(remoteStopRequest));

            // OK status
            console.log('Message sent to the WebSocket client for device ID:', deviceIDToSendTo);
            res.statusCode = 200;
            res.end('Message sent to the WebSocket client for device ID: ' + deviceIDToSendTo);
        } else {
            // Charger ID Not Found/Available
            console.log('WebSocket client not found for the specified device ID:', deviceIDToSendTo);
            res.statusCode = 400;
            res.end('WebSocket client not found for the specified device ID: ' + deviceIDToSendTo);
        }

    } else if (req.url.startsWith('/OCPPJ/')) {

        RECEIVED_ID = req.url.split('/').pop();
        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        collection.findOne({ yourField: RECEIVED_ID })
            .then(result => {
                if (result) {
                    wss.handleUpgrade(req, req.socket, Buffer.from([]), (ws) => {
                        wss.emit('connection', ws, req);
                    });
                } else {
                    res.writeHead(404);
                    console.log("Device not available in database");
                }
            })
            .catch(error => {
                console.log(error);
            });

    } else if (req.method === 'GET' && req.url === '/') { // Serve index.html for the root path
        fs.readFile('./public/index.html', 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Internal Server Error');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            }
        });
    } else {
        res.writeHead(404);
        res.end('Invalid Request');
    }

});

wss.on('connection', (ws,req) => {

    const clientIpAddress = req.connection.remoteAddress;
    console.log(`${clientIpAddress} & ${RECEIVED_ID}`);

    const db = client.db(dbName);

    // Create a query to match the documents
    const query = { yourField: RECEIVED_ID };

    // Create an update operation to set the IP address
    const updateOperation = { $set: { ip: clientIpAddress } };

    // Update a single document
    db.collection('ev_details').updateOne(query, updateOperation, function (err, result) {
    if (err) throw err;
        console.log(`Matched ${result.matchedCount} document(s) and modified ${result.modifiedCount} document(s)`);
    });

    db.collection('ev_charger_status').updateOne({ chargerID: RECEIVED_ID}, { $set: { clientIP: clientIpAddress }}, function (err, result) {
    if (err) throw err;
        console.log(`Matched ${result.matchedCount} document(s) and modified ${result.modifiedCount} document(s)`);
    });

    // Store the source IP address associated with the WebSocket connection
    clients.set(ws, clientIpAddress);
   
    // Handle WebSocket closure
    ws.on('close', (code, reason) => {
        if (code === 1000) {
            console.log('WebSocket closed');
        } else {
            console.log(`WebSocket closed unexpectedly with code ${code} and reason: ${reason}`);
            // Implement reconnection logic for unexpected closures
            setTimeout(() => {
                console.log('Attempting to reconnect WebSocket...');
                connectWebSocket(ws);
            }, 1000); // Retry after 5 seconds
        }
    });

    ws.on('message', async (message) => {
        const currentDate = new Date();
        const formattedDate = currentDate.toISOString();

        if (typeof message === 'object') {
            try {
                const requestData = JSON.parse(message);
                //console.log('WebSocket message' + message);

                const sourceIP = clients.get(ws);
                console.log(`Received message from client with IP ${sourceIP}: ${message}`);

                const parsedMessage = JSON.parse(message);

                if (Array.isArray(requestData) && requestData.length >= 4) {
                    const requestType = requestData[0];
                    const uniqueIdentifier = requestData[1];
                    const requestName = requestData[2];
                    const additionalData = requestData[3];

                    if (requestType === 2 && requestName === "BootNotification") {
                        console.log(`Received BootNotification request with unique identifier: ${uniqueIdentifier}`);
                        const response = [3, uniqueIdentifier, {
                            "status": "Accepted",
                            "currentTime": new Date().toISOString(),
                            "interval": 14400
                        }];
                        ws.send(JSON.stringify(response));
                    } else if (requestType === 2 && requestName === "StatusNotification") {
                        const response = [3, "a6gs8797ewYM06", {}];
                        ws.send(JSON.stringify(response));
                        const status = parsedMessage[3].status;
                        if (status != undefined) {
                            const keyValPair = {};
                            keyValPair.status = status;
                            keyValPair.timestamp = new Date();
                            keyValPair.clientIP = clientIpAddress;
                            const Chargerstatus = JSON.stringify(keyValPair);
                            SaveChargerStatus(Chargerstatus);
                            //console.log(Chargerstatus);
                        }
                    } else if (requestType === 2 && requestName === "Heartbeat") {
                        const response = [3, "a6gs8797ewYM03", { "currentTime": formattedDate }];
                        ws.send(JSON.stringify(response));
                    } else if (requestType === 2 && requestName === "Authorize") {
                        const response = [3, uniqueIdentifier, { "idTagInfo": { "status": "Accepted", "parentIdTag": "B4A63CDB" } }];
                        ws.send(JSON.stringify(response));
                    } else if (requestType === 2 && requestName === "StartTransaction") {
                        const response = [3, uniqueIdentifier, { "transactionId": 1027020, "idTagInfo": { "status": "Accepted", "parentIdTag": "B4A63CDB" } }];
                        ws.send(JSON.stringify(response));
                    } else if (requestType === 2 && requestName === "MeterValues") {
                        const response = [3, uniqueIdentifier, {}];
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
                        SaveChargerValue(ChargerValue);
                    } else if (requestType === 2 && requestName === "StopTransaction") {
                        const response = [3, uniqueIdentifier, {}];
                        ws.send(JSON.stringify(response));
                    }
                }
            } catch (error) {
                console.error('Error parsing or processing the message:', error);
            }
        }
    });

    connectWebSocket(ws);

});

function SaveChargerStatus(chargerStatus) {

    const db = client.db(dbName);
    const collection = db.collection('ev_charger_status');
    const ChargerStatus = JSON.parse(chargerStatus);

    // Check if a document with the same chargerID already exists
    collection.findOne({ clientIP: ChargerStatus.clientIP})
        .then(existingDocument => {
            if (existingDocument) {
                // Update the existing document
                collection.updateOne(
                    { clientIP: ChargerStatus.clientIP },
                    { $set: {status: ChargerStatus.status, timestamp: ChargerStatus.timestamp} }
                )
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

                    console.log(ChargerStatus);

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

function SaveChargerValue(ChargerVal) {


    const db = client.db(dbName);
    const collection = db.collection('ev_charger_values');
    const ChargerValue = JSON.parse(ChargerVal);

    db.collection('ev_details').findOne({ ip: ChargerValue.clientIP })
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

server.listen(8050, () => {
    console.log('Server is running on port 8050');
});