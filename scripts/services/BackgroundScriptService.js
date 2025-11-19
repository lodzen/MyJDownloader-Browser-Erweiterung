"use strict";

angular.module('myjdWebextensionApp')
    .service('BackgroundScriptService', ['$q', 'myjdClientFactory', 'myjdDeviceClientFactory', function ($q, myjdClientFactory, myjdDeviceClientFactory) {
        const connectionListeners = [];
        const apiErrorListeners = [];
        const deviceListeners = [];
        const devicePollListeners = {};

        const myjd = myjdClientFactory.get();

        if (myjd && myjd.getConnectionObservable && myjd.getConnectionObservable().subscribe) {
            myjd.getConnectionObservable().subscribe(function (event) {
                const isLoggedIn = event && event.result === myjd.CONNECTION_STATES.CONNECTED;
                emit(connectionListeners, {
                    data: { isLoggedIn: isLoggedIn },
                    error: event ? event.error : undefined
                });
            });
        }

        function emit(listeners, payload) {
            listeners.forEach(function (listener) {
                try {
                    listener(payload);
                } catch (e) {
                    console.error(e);
                }
            });
        }

        function registerListener(list, callback) {
            if (typeof callback !== "function") {
                return angular.noop;
            }
            list.push(callback);
            return function () {
                const index = list.indexOf(callback);
                if (index >= 0) {
                    list.splice(index, 1);
                }
            };
        }

        function registerDevicePollListener(deviceId, callback) {
            if (!deviceId || typeof callback !== "function") {
                return angular.noop;
            }
            if (!devicePollListeners[deviceId]) {
                devicePollListeners[deviceId] = [];
            }
            devicePollListeners[deviceId].push(callback);
            return function () {
                const list = devicePollListeners[deviceId];
                if (!list) return;
                const index = list.indexOf(callback);
                if (index >= 0) {
                    list.splice(index, 1);
                }
            };
        }

        function notifyDevicePoll(deviceId, payload) {
            const listeners = devicePollListeners[deviceId];
            if (!listeners) {
                return;
            }
            listeners.forEach(function (listener) {
                try {
                    listener(payload);
                } catch (e) {
                    console.error(e);
                }
            });
        }

        function notifyApiError(error) {
            emit(apiErrorListeners, { data: { error: error }, error: error });
        }

        function getSessionInfo() {
            return $q(function (resolve) {
                resolve({
                    data: {
                        isLoggedIn: myjd && myjd.isConnected ? myjd.isConnected() : false
                    }
                });
            });
        }

        function getUsername() {
            return $q(function (resolve, reject) {
                try {
                    const username = myjd && myjd.api && myjd.api.jdAPICore && myjd.api.jdAPICore.options
                        ? myjd.api.jdAPICore.options.email
                        : undefined;
                    resolve({ username: username });
                } catch (e) {
                    reject(e);
                }
            });
        }

        function logout() {
            return myjd.disconnect();
        }

        function login(credentials) {
            return myjd.connect(credentials);
        }

        function getDevices() {
            return $q(function (resolve, reject) {
                myjd.getDeviceList().then(function (result) {
                    const devices = extractDevices(result);
                    const payload = { data: { devices: devices } };
                    emit(deviceListeners, payload);
                    resolve(payload);
                }).catch(function (error) {
                    const payload = { error: error };
                    notifyApiError(error);
                    reject(payload);
                });
            });
        }

        function addLink(device, addLinkQuery) {
            return sendJsonDeviceRequest(device, "/linkgrabberv2/addLinks", addLinkQuery);
        }

        function sendFeedback(message) {
            return $q(function (resolve, reject) {
                myjd.sendFeedback(message).done(function (response) {
                    resolve(response);
                }).fail(function (error) {
                    notifyApiError(error);
                    reject(error);
                });
            });
        }

        function addCnl(device, addCnlQuery) {
            return sendJsonDeviceRequest(device, "/flash/addcnl", addCnlQuery);
        }

        function onConnectionChanged(callback) {
            return registerListener(connectionListeners, callback);
        }

        function onApiError(callback) {
            return registerListener(apiErrorListeners, callback);
        }

        function onDeviceListChanged(callback) {
            return registerListener(deviceListeners, callback);
        }

        function onDevicePoll(deviceId, callback) {
            return registerDevicePollListener(deviceId, callback);
        }

        function devicePoll(device) {
            return $q(function (resolve, reject) {
                if (!device || !device.id) {
                    reject({ error: "invalid_device" });
                    return;
                }
                myjdDeviceClientFactory.get(device).getAggregatedNumbers().done(function (stats) {
                    const payload = { data: interpretAggregatedNumbers(stats) };
                    notifyDevicePoll(device.id, payload);
                    resolve(payload);
                }).fail(function (error) {
                    const payload = { error: error };
                    notifyDevicePoll(device.id, payload);
                    notifyApiError(error);
                    reject(payload);
                });
            });
        }

        function startDevicePoll(device, interval) {
            if (!device) return;
            try {
                myjdDeviceClientFactory.get(device).poll(interval || 4000);
            } catch (e) {
                console.error(e);
            }
        }

        function stopDevicePoll(device) {
            if (!device) return;
            try {
                myjdDeviceClientFactory.get(device).stopPolling();
            } catch (e) {
                console.error(e);
            }
        }

        function sendApiRequest(device, action, params) {
            return $q(function (resolve, reject) {
                if (!device || !action) {
                    reject({ error: "invalid_request" });
                    return;
                }
                myjdDeviceClientFactory.get(device).sendRequest(action, params).done(function (result) {
                    resolve({ data: result });
                }).fail(function (error) {
                    notifyApiError(error);
                    reject({ error: error });
                });
            });
        }

        function sendJsonDeviceRequest(device, endpoint, payload) {
            return $q(function (resolve, reject) {
                if (!device || !endpoint) {
                    reject({ error: "invalid_request" });
                    return;
                }
                myjdDeviceClientFactory.get(device).sendRequest(endpoint, JSON.stringify(payload)).done(function (result) {
                    resolve({ data: result });
                }).fail(function (error) {
                    notifyApiError(error);
                    reject({ error: error });
                });
            });
        }

        function extractDevices(result) {
            if (!result) {
                return [];
            }
            if (Array.isArray(result.result)) {
                return result.result;
            }
            if (result.result && Array.isArray(result.result.list)) {
                return result.result.list;
            }
            return [];
        }

        function interpretAggregatedNumbers(stats) {
            if (!stats || !stats.data || !Array.isArray(stats.data)) {
                return {};
            }
            const jdState = stats.data[0] && stats.data[0].eventData ? stats.data[0].eventData.data : undefined;
            const numbers = stats.data[1] && stats.data[1].eventData ? stats.data[1].eventData.data : {};
            return {
                state: jdState,
                eta: numbers ? numbers.eta : undefined,
                speed: numbers ? numbers.downloadSpeed : undefined,
                done: numbers ? numbers.loadedBytes : undefined,
                total: numbers ? numbers.totalBytes : undefined
            };
        }

        this.getDevices = getDevices;
        this.addLink = addLink;
        this.addCnl = addCnl;
        this.getSessionInfo = getSessionInfo;
        this.getUsername = getUsername;
        this.logout = logout;
        this.login = login;
        this.startDevicePoll = startDevicePoll;
        this.stopDevicePoll = stopDevicePoll;
        this.onConnectionChanged = onConnectionChanged;
        this.onApiError = onApiError;
        this.onDeviceListChanged = onDeviceListChanged;
        this.onDevicePoll = onDevicePoll;
        this.devicePoll = devicePoll;
        this.sendFeedback = sendFeedback;
        this.sendApiRequest = sendApiRequest;
    }]);