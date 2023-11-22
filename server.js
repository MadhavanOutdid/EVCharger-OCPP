const http = require('http');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const url = require('url');

const wss = new WebSocket.Server({ noServer: true });
const deviceToWebSocketMap = new Map();

const dbUrl = 'mongodb://127.0.0.1:27017/';
const dbName = 'ev';
const collectionName = 'ev_details';

const client = new MongoClient(dbUrl);
client.connect();

wss.on('connection', (ws) => {
    console.log('WebSocket connected');

    global.ID = '';

    // Connect to MongoDB and fetch data
    MongoClient.connect(dbUrl)
        .then((client) => {
            const db = client.db(dbName);
            const collection = db.collection(collectionName);

            return collection.find({}).toArray();
        })
        .then((deviceDocs) => {
            deviceDocs.forEach((deviceDoc) => {
                ID = deviceDoc.yourField;
                const deviceID = '/OCPPJ/' + ID;
                deviceToWebSocketMap.set(deviceID, ws);
            });

            console.log('WebSocket clients stored in map for all devices');
        })
        .catch((err) => {
            console.error('Error connecting to MongoDB or fetching data:', err);
        });

    ws.on('message', async (message) => {
        const currentDate = new Date();
        const formattedDate = currentDate.toISOString();

        if (typeof message === 'object') {
            try {
                const requestData = JSON.parse(message);
                console.log('WebSocket connected' + message);

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
                            keyValPair.chargerID = ID;
                            keyValPair.status = status;
                            keyValPair.timestamp = new Date();
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
                        keyValuePair.chargerID = ID;
                        const ChargerValue = JSON.stringify(keyValuePair);
                        SaveChargerValue(ChargerValue);
                        //console.log(ChargerValue);
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
});

function SaveChargerStatus(chargerStatus) {

    const db = client.db(dbName);
    const collection = db.collection('ev_charger_status');
    const ChargerStatus = JSON.parse(chargerStatus);

    // Check if a document with the same chargerID already exists
    collection.findOne({ chargerID: ChargerStatus.chargerID })
        .then(existingDocument => {
            if (existingDocument) {
                // Update the existing document
                collection.updateOne(
                    { chargerID: ChargerStatus.chargerID },
                    { $set: ChargerStatus }
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
                // Insert a new document
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
            }
        })
        .catch(error => {
            console.log(error);
        });


}

function SaveChargerValue(ChargerValue) {

    const db = client.db(dbName);
    const collection = db.collection('ev_charger_values');

    collection.insertOne(JSON.parse(ChargerValue))
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

        const db = client.db(dbName);
        const collection = db.collection(collectionName);
        const DeviceID = req.url.split('/').pop();

        collection.findOne({ yourField: DeviceID })
            .then(result => {
                if (result) {
                    wss.handleUpgrade(req, req.socket, Buffer.from([]), (ws) => {
                        wss.emit('connection', ws, req);
                    });
                } else {
                    res.writeHead(404);
                    console.log("Device not Found");
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

server.listen(8050, () => {
    console.log('Server is running on port 8050');
});