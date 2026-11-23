'use strict';

/**
 * @ngdoc function
 * @name myjdWebextensionApp.controller:PopupCtrl
 * @description
 * # PopupCtrl
 * Controller of the myjdWebextensionApp
 */

angular.module('myjdWebextensionApp')
    .controller('PopupCtrl', ['$rootScope', '$scope', '$http', '$timeout', '$location', 'BackgroundScriptService', 'ApiErrorService', function ($rootScope, $scope, $http, $timeout, $location, BackgroundScriptService, ApiErrorService) {
        var loadBuildMeta = function () {
            var buildMetaReq = new XMLHttpRequest();
            buildMetaReq.open("GET", chrome.runtime.getURL('../../buildMeta.json'));
            if (buildMetaReq.overrideMimeType) {
                buildMetaReq.overrideMimeType("application/json");
            }
            buildMetaReq.addEventListener('load', function (event) {
                if (buildMetaReq.status >= 200 && buildMetaReq.status < 300) {
                    $timeout(function () {
                        $scope.isOutdatedVersion = (new Date().getTime() - buildMetaReq.response.timestamp) > (1000 * 60 * 60 * 24 * 90);
                    }, 0);
                } else {
                    console.error(buildMetaReq.statusText, buildMetaReq.responseText);
                }
            });
            buildMetaReq.send();
        };
        loadBuildMeta();

        resetScope();
        $rootScope.bodyClass = "browserActionContainer";
        $scope.credentials = {email: undefined, password: undefined};
        $scope.state.isInitializing = true;

        // Pending CNL/link requests take precedence - jump straight to the
        // add-links view so the user can pick a target JDownloader.
        chrome.runtime.sendMessage({name: "myjd-toolbar", action: "link-info"}, function (response) {
            if (chrome.runtime.lastError || !response || !response.data) {
                return;
            }
            if (response.data.length > 0) {
                $timeout(function () {
                    $location.path('/toolbar').search('popup', 'true');
                }, 0);
            }
        });

        // Check storage immediately to set optimistic UI state
        // This ensures the UI shows the correct state even if API is still initializing
        chrome.storage.local.get('MYJD_CONNECTION_ACTIVE', function (result) {
            const storageConnected = result && result.MYJD_CONNECTION_ACTIVE === true;
            if (storageConnected) {
                $timeout(function () {
                    // Set optimistic state from storage
                    $scope.state.isLoggedIn = true;
                    // Keep isInitializing true until API confirms
                }, 0);
            }
        });

        // Still check API state for confirmation
        BackgroundScriptService.getSessionInfo().then(function (result) {
            $timeout(function () {
                $scope.state.isConnecting = false;
                $scope.state.isInitializing = false;
                if (result.data.isLoggedIn === false) {
                    $scope.state.loading = false;
                    $scope.state.isLoggedIn = false;
                } else if (result.data.isLoggedIn === true) {
                    $scope.state.isLoggedIn = true;
                }
            }, 0);
        }).catch(function () {
            $timeout(function () {
                $scope.state.isConnecting = false;
                $scope.state.loading = false;
                $scope.state.isLoggedIn = false;
                $scope.state.isInitializing = false;
            }, 0);
        });

        function resetScope() {
            $scope.state = {
                'isConnecting': false,
                'isLoggedIn': false,
                'isInitializing': false,
                'successMessage': undefined,
                'error': undefined
            };
        }

        chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
            // Handle forwarded messages from service worker
            if (message._fromServiceWorker && message.name === "myjd-toolbar") {
                var action = message.action;
                console.log('Popup: Received forwarded message from service worker', action);
                
                if (action === "login") {
                    // Handle login request from service worker
                    // message.data contains { credentials: { email, password } }
                    console.log('Popup: Processing login request', { hasData: !!message.data, hasCredentials: !!(message.data && message.data.credentials) });
                    
                    if (message.data && message.data.credentials) {
                        // Execute the actual API call
                        console.log('Popup: Calling BackgroundScriptService.login');
                        BackgroundScriptService.login(message.data.credentials).then(function (result) {
                            console.log('Popup: Login successful', result);
                            sendResponse({ data: true });
                        }, function (error) {
                            console.error('Popup: Login failed', error);
                            sendResponse({ data: false, error: error });
                        });
                    } else {
                        console.warn('Popup: Login request missing credentials');
                        sendResponse({ error: "credentials missing" });
                    }
                    return true; // Keep channel open for async response
                } else if (action === "session-info") {
                    // Handle session info request
                    BackgroundScriptService.getSessionInfo().then(function (result) {
                        sendResponse({ data: { isLoggedIn: result.data.isLoggedIn } });
                    }, function () {
                        sendResponse({ data: { isLoggedIn: false } });
                    });
                    return true; // Keep channel open for async response
                } else if (action === "logout") {
                    // Handle logout request
                    BackgroundScriptService.logout().then(function () {
                        sendResponse({ data: true });
                    }, function (error) {
                        sendResponse({ data: false, error: error });
                    });
                    return true; // Keep channel open for async response
                } else if (action === "devices-pull") {
                    // Handle devices pull request
                    BackgroundScriptService.getDevices().then(function (result) {
                        sendResponse({ data: { devices: result.data.devices } });
                    }, function (error) {
                        sendResponse({ error: error });
                    });
                    return true; // Keep channel open for async response
                }
            }
            
            // Handle connection state changes
            if (message.action === "CONNECTION_STATE_CHANGE" && message.name === "myjd-toolbar") {
                if (message.data === "CONNECTED") {
                    $timeout(function () {
                        $scope.state.isLoggedIn = true;
                    }, 0);
                } else if (message.data === "DISCONNECTED") {
                    $scope.state.isLoggedIn = false;
                }
            }
            
            // Handle session-change messages
            if (message.action === "session-change" && message.name === "myjd-toolbar") {
                if (message.data && message.data.isLoggedIn !== undefined) {
                    $timeout(function () {
                        $scope.state.isInitializing = false;
                        if (message.data.isLoggedIn === false) {
                            $scope.state.loading = false;
                            $scope.state.isLoggedIn = false;
                        } else if (message.data.isLoggedIn === true) {
                            $scope.state.isLoggedIn = true;
                        }
                    }, 0);
                }
            }
        });

        BackgroundScriptService.onConnectionChanged(function (request) {
            if (request.data && request.data.isLoggedIn !== undefined) {
                $timeout(function () {
                    $scope.state.isInitializing = false;
                    if (request.data.isLoggedIn === false) {
                        $scope.state.loading = false;
                        $scope.state.isLoggedIn = false;
                    } else if (request.data.isLoggedIn === true) {
                        $scope.state.isLoggedIn = true;
                    }
                }, 0);
            }
        });

        $scope.showLoggedOutSettings = function () {
            $timeout(function () {
                $scope.state.error = undefined;
                $scope.state.showSettings = true;
            });
        };

        $scope.hideSettings = function () {
            $timeout(function () {
                $scope.state.showSettings = false;
            });
        };

        $scope.theme = window.myjdTheme ? window.myjdTheme.get() : 'auto';
        $scope.toggleTheme = function () {
            if (window.myjdTheme) {
                $scope.theme = window.myjdTheme.toggle();
            }
        };

        $scope.login = function (credentials) {
            if ($scope.loginForm.$valid) {
                resetScope();
                $scope.isConnecting = true;

                // Call API directly since popup has access to MyjdService
                console.log('Popup: Calling BackgroundScriptService.login directly', { hasEmail: !!credentials.email, hasPassword: !!credentials.password });
                BackgroundScriptService.login(credentials).then(function (result) {
                    console.log('Popup: Login successful, notifying service worker');
                    $timeout(function () {
                        $scope.state.isConnecting = false;
                        if (result !== undefined && result.error === undefined) {
                            $scope.state.isInitializing = false;
                            $scope.state.loading = false;
                            $scope.state.isLoggedIn = true;
                            
                            // Notify service worker to initialize context menus
                            chrome.runtime.sendMessage({
                                name: "myjd-toolbar",
                                action: "login-success",
                                data: { success: true }
                            }, function() {
                                // Ignore errors - service worker might not be ready
                                if (chrome.runtime.lastError) {
                                    console.log('Service worker notification error (can be ignored):', chrome.runtime.lastError.message);
                                }
                            });
                        } else {
                            $scope.state.isLoggedIn = false;
                            if (result && result.error) {
                                var readableError = ApiErrorService.createReadableApiError(result.error);
                                if (readableError) {
                                    $scope.state.error = readableError;
                                } else {
                                    $scope.state.error = "Sorry, an unknown error happened. Please let us know!";
                                }
                            }
                        }
                    }, 0);
                }, function (error) {
                    // Log error with full details
                    console.error('Popup: Login failed');
                    if (error) {
                        console.error('Popup: Error status:', error.status);
                        console.error('Popup: Error type:', error.type);
                        console.error('Popup: Error message:', error.message);
                        console.error('Popup: Error stringified:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
                    }
                    
                    $timeout(function () {
                        $scope.state.isConnecting = false;
                        var readableError = ApiErrorService.createReadableApiError(error);
                        if (readableError && readableError.message) {
                            $scope.state.error = readableError;
                        } else {
                            // Try to extract error message from various error formats
                            var errorMessage = "Sorry, an unknown error happened. Please let us know!";
                            if (error && error.message) {
                                errorMessage = error.message;
                            } else if (error && typeof error === 'string') {
                                errorMessage = error;
                            } else if (error && error.toString && error.toString() !== '[object Object]') {
                                errorMessage = error.toString();
                            } else if (error && error.type) {
                                errorMessage = "Error: " + error.type;
                            }
                            $scope.state.error = errorMessage;
                        }
                        
                        // Notify service worker of failure
                        chrome.runtime.sendMessage({
                            name: "myjd-toolbar",
                            action: "login-failed",
                            data: { error: error }
                        }, function() {
                            if (chrome.runtime.lastError) {
                                console.log('Service worker notification error (can be ignored):', chrome.runtime.lastError.message);
                            }
                        });
                    }, 0);
                });
            }
        };
    }]);
