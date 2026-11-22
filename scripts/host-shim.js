/*
 * Local host shim for the self-hosted Melon Sandbox build.
 *
 * The Unity web build is published to run inside https://melonsandbox.com/:
 * its MelWebSdk only finishes initialising after the parent page answers the
 * "hello" handshake with "modules-initialized" and serves state-data for each
 * module (auth, settings, store, adv, event-tracker).
 *
 * The message shapes below were captured live from melonsandbox.com's parent
 * frame.  The handshake itself follows the sequence the SDK actually accepts
 * here (the site's extra parent-initiated hello and its unmatched state-data
 * pushes were replayed too and were verified to tear the module manager down
 * again, so they are deliberately left out).
 *
 * The one substantive change over the site is the auth payload: the site sends
 * {token, tokenExpiredAt, userId, userKind, eventJwt, tokenTtlSeconds} and the
 * game's session setup needs all of them.  Their values come from the
 * publisher's own device auth endpoint.
 */
(function () {
    'use strict';

    /* The SDK posts every request to window.parent and only accepts replies
       whose source is window.parent again.  That is this page when the build is
       opened directly, but it is the surrounding site when the build runs in
       the game launcher's iframe, so the handshake never reaches the shim.
       window.parent is [Replaceable]; shadow it with this window and the SDK
       keeps talking to the shim either way. */
    if (window.parent && window.parent !== window) {
        try { window.parent = window; } catch (err) {}
    }

    // Captured before anything else wraps it, so the shim's own auth call can
    // never recurse through the API wrapper installed further down.
    var nativeFetch = window.fetch;

    var HOST_ORIGIN = 'https://melonsandbox.com';
    var GAME_SOURCE = 'melon-web-game-app';
    var HOST_SOURCE = 'melon-web-app';
    var ACTIVE_HOST = 'https://pg-proxy.playmelonpg.com';
    var STORE_LINKS = {
        content: 'https://melonsandbox.com/store/content/{0}',
        storeItem: 'https://melonsandbox.com/store/store-item/{0}'
    };

    // Stable pseudo identity so the game has something to key local data on.
    var DEVICE_ID = 'local-web-' + (localStorage.getItem('melon-shim-device') || (function () {
        var id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        localStorage.setItem('melon-shim-device', id);
        return id;
    })());

    var API_BASE = ACTIVE_HOST + '/api';
    var AUTH_KEY = 'melon-shim-auth-' + DEVICE_ID;
    var APP_VERSION = '38.666';
    var authPromise = null;

    function cachedAuth() {
        try {
            var raw = localStorage.getItem(AUTH_KEY);
            if (!raw) return null;
            var data = JSON.parse(raw);
            if (!data || !data.jwt) return null;
            if (data.jwtExpiredAt && data.jwtExpiredAt - Date.now() < 120000) return null;
            return data;
        } catch (err) {
            return null;
        }
    }

    function ensureAuth() {
        if (authPromise) return authPromise;
        var cached = cachedAuth();
        if (cached) {
            authPromise = Promise.resolve(cached);
            return authPromise;
        }
        authPromise = nativeFetch(API_BASE + '/auth/v2/by-device', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-platform': 'web',
                'x-device-id': DEVICE_ID,
                'x-app-version': APP_VERSION
            },
            body: JSON.stringify({
                devicePlatform: 'web',
                externalDeviceId: DEVICE_ID
            })
        }).then(function (response) {
            if (!response.ok) throw new Error('auth http ' + response.status);
            return response.json();
        }).then(function (data) {
            if (data && data.jwt) {
                try { localStorage.setItem(AUTH_KEY, JSON.stringify(data)); } catch (err) {}
            }
            return data;
        }).catch(function (err) {
            console.warn('[host-shim] device auth failed', err);
            return null;
        });
        return authPromise;
    }

    // Exactly the fields the real site forwards.  MelonSite_AuthData validates
    // token / tokenExpiredAt / userKind; eventJwt and tokenTtlSeconds are what
    // the game's event tracker and session timer use.
    function authPayload(data) {
        if (!data || !data.jwt) {
            return {
                token: null,
                tokenExpiredAt: 0,
                userId: null,
                userKind: 'anonymousPlayer',
                eventJwt: null,
                tokenTtlSeconds: 0
            };
        }
        return {
            token: data.jwt,
            tokenExpiredAt: data.jwtExpiredAt,
            userId: data.userId,
            userKind: data.userKind || 'anonymousPlayer',
            eventJwt: data.eventJwt,
            tokenTtlSeconds: data.tokenTtlSeconds
        };
    }

    // First visit: the game would boot before the device token exists. Fetch it
    // and reload once so the very first API calls already carry the token.
    if (!cachedAuth()) {
        var RELOAD_FLAG = 'melon-shim-authed';
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
            ensureAuth().then(function (data) {
                if (data && data.jwt && !sessionStorage.getItem(RELOAD_FLAG)) {
                    sessionStorage.setItem(RELOAD_FLAG, '1');
                    location.reload();
                }
            });
        }
    }

    var STATE = {
        settings: { language: 'en' },
        auth: {
            deviceId: DEVICE_ID,
            isGoogleAvailable: false,
            isAuthorized: true,
            isGuest: true
        },
        store: { isAvailable: false, links: STORE_LINKS },
        adv: { isAvailable: false },
        eventTracker: { isAvailable: false }
    };

    function post(data) {
        var event;
        try {
            event = new MessageEvent('message', {
                data: data,
                origin: HOST_ORIGIN,
                source: window
            });
        } catch (err) {
            event = document.createEvent('MessageEvent');
            event.initMessageEvent('message', false, false, data, HOST_ORIGIN, '', window, null);
        }
        window.dispatchEvent(event);
    }

    function reply(module, event, id, payload, type, submodule) {
        var data = { id: id };
        if (payload !== undefined) data.result = payload;
        var message = { module: module };
        if (submodule) message.submodule = submodule;
        message.event = event;
        message.type = type || 'success';
        message.data = data;
        message.source = HOST_SOURCE;
        post(message);
    }

    function stateData(module, id, payload, submodule) {
        var message = { module: module };
        if (submodule) message.submodule = submodule;
        message.event = 'state-data';
        message.type = 'success';
        message.data = { id: id, result: payload };
        message.source = HOST_SOURCE;
        post(message);
    }

    var modulesSent = false;
    function sendModulesInitialized(id) {
        if (modulesSent) return;
        modulesSent = true;
        post({
            module: 'global',
            event: 'modules-initialized',
            data: {
                id: id,
                hostModuleCreated: true,
                adv: {},
                auth: {},
                eventTracker: {},
                settings: {},
                store: {}
            },
            source: HOST_SOURCE
        });
        // The site primes the wallet once the store module is up.
        setTimeout(function () {
            post({
                module: 'store',
                event: 'update-wallet-coins',
                type: 'success',
                data: { id: Date.now(), coins: 0 },
                source: HOST_SOURCE
            });
        }, 400);
    }

    function handle(data) {
        var module = data.module;
        var submodule = data.submodule;
        var event = data.event;
        var id = data.data && data.data.id;

        if (module === 'global') {
            if (event === 'hello' && data.type === 'start') {
                post({
                    module: 'global',
                    event: 'hello',
                    type: 'success',
                    data: { id: id },
                    source: HOST_SOURCE
                });
                // Modules can only be announced once the game saw "success".
                setTimeout(function () { sendModulesInitialized(id); }, 0);
            }
            return;
        }

        // The game reports its boot steps; the site does not answer them.
        if (event === 'game-step' || event === 'get-app-version') return;

        if (module === 'host' && event === 'request-initial-data') {
            return stateData(module, id, { activeHost: ACTIVE_HOST });
        }

        if (event === 'request-initial-data') {
            if (module === 'auth') return stateData(module, id, STATE.auth);
            if (module === 'settings') {
                stateData(module, id, STATE.settings);
                return post({
                    module: 'settings',
                    event: 'language-changed',
                    type: 'success',
                    data: { id: Date.now(), language: STATE.settings.language },
                    source: HOST_SOURCE
                });
            }
            if (module === 'store') return stateData(module, id, STATE.store);
            if (module === 'adv') return stateData(module, id, STATE.adv);
            if (module === 'event-tracker') return stateData(module, id, STATE.eventTracker, submodule);
            return stateData(module, id, {}, submodule);
        }

        if (event === 'get-auth-data') {
            // Called whenever the game needs a signed token for the publisher's
            // backend.  The SDK hands the payload fields straight to the game,
            // so they must sit next to "id", not under "result".
            ensureAuth().then(function (auth) {
                var payload = authPayload(auth);
                post({
                    module: module,
                    event: event,
                    type: 'success',
                    data: {
                        id: id,
                        token: payload.token,
                        tokenExpiredAt: payload.tokenExpiredAt,
                        userId: payload.userId,
                        userKind: payload.userKind,
                        eventJwt: payload.eventJwt,
                        tokenTtlSeconds: payload.tokenTtlSeconds
                    },
                    source: HOST_SOURCE
                });
            });
            return;
        }

        if (event === 'show-login') {
            return; // nothing to show - there is no account backend here
        }

        if (event === 'request-change-language') {
            var language = (data.data && data.data.language) || 'en';
            stateData(module, id, { language: language });
            return post({
                module: module,
                event: 'language-changed',
                type: 'success',
                data: { id: Date.now(), language: language },
                source: HOST_SOURCE
            });
        }

        // Every remaining request (store content, downloads, ads, analytics)
        // gets the same shape the site answers with: success + the same id.
        if (id !== undefined && id !== null) {
            return reply(module, event, id);
        }
    }

    // --- diagnostics: record what the game asks its backend and its host -------
    window.__melonApi = [];
    window.__melonSdk = [];
    window.__melonHost = [];
    window.__melonLogs = [];

    ['log', 'warn', 'error'].forEach(function (level) {
        var original = console[level];
        if (!original) return;
        console[level] = function () {
            try {
                if (window.__melonLogs.length < 400) {
                    var text = '';
                    for (var i = 0; i < arguments.length; i++) {
                        var value = arguments[i];
                        if (typeof value === 'string') text += value + ' ';
                        else if (typeof value === 'number' || typeof value === 'boolean') text += value + ' ';
                    }
                    if (text && (level !== 'log' || /External app|MelonSite|MelonSdk|MelonSDK|\[JS|Unity/i.test(text))) {
                        window.__melonLogs.push({ level: level, text: text.slice(0, 300), at: Date.now() });
                    }
                }
            } catch (err) {}
            return original.apply(console, arguments);
        };
    });

    function isApi(url) {
        return url.indexOf('playmelonpg') !== -1 || url.indexOf('melonsandbox') !== -1 || url.indexOf('xsolla') !== -1;
    }

    function logFetch(entry, response) {
        entry.status = response.status;
        if (isApi(entry.url)) {
            response.clone().text().then(function (body) {
                entry.body = body.slice(0, 600);
            }).catch(function () {});
        }
        return response;
    }

    if (nativeFetch) {
        window.fetch = function (input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var method = (init && init.method) || (input && input.method) || 'GET';
            var entry = { url: url, method: method, at: Date.now() };
            if (isApi(url)) window.__melonApi.push(entry);

            // The lobby discovery service only answers origins it trusts, and
            // its reply is public cluster routing information.  Serve it here.
            if (url.indexOf('us-discovery-01.playmelonpg.com/v1/resolve') !== -1) {
                var cluster = {
                    cluster: { id: 1, code: 'us-prod-01', baseUrl: 'https://us-mp-01.playmelonpg.com' },
                    resolvedBy: 'host-shim',
                    geo: { continent: 'NA', country: 'US' }
                };
                entry.status = 200;
                entry.body = JSON.stringify(cluster);
                return Promise.resolve(new Response(JSON.stringify(cluster), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                }));
            }

            // The game expects its parent page to have authorised it already.
            // Attach the device session to every API call that needs one.
            if (url.indexOf('pg-proxy.playmelonpg.com') !== -1) {
                return ensureAuth().then(function (auth) {
                    if (!auth || !auth.jwt) return nativeFetch(input, init);
                    var request;
                    try {
                        request = new Request(input, init);
                        request.headers.set('authorization', 'Bearer ' + auth.jwt);
                    } catch (err) {
                        return nativeFetch(input, init);
                    }
                    return nativeFetch(request).then(function (response) {
                        return logFetch(entry, response);
                    }, function (err) {
                        entry.error = String(err);
                        throw err;
                    });
                });
            }

            return nativeFetch(input, init).then(function (response) {
                return logFetch(entry, response);
            }, function (err) {
                entry.error = String(err);
                throw err;
            });
        };
    }

    var NativeXHR = window.XMLHttpRequest;
    if (NativeXHR && NativeXHR.prototype) {
        var open = NativeXHR.prototype.open;
        NativeXHR.prototype.open = function (method, url) {
            this.__melonUrl = url;
            this.__melonMethod = method;
            return open.apply(this, arguments);
        };
        var setHeader = NativeXHR.prototype.setRequestHeader;
        var xhrSend = NativeXHR.prototype.send;
        NativeXHR.prototype.send = function () {
            var xhr = this;
            var url = String(xhr.__melonUrl || '');
            if (!isApi(url)) return xhrSend.apply(this, arguments);

            var entry = { url: url, method: xhr.__melonMethod, at: Date.now() };
            window.__melonApi.push(entry);
            xhr.addEventListener('loadend', function () {
                entry.status = xhr.status;
                try { entry.body = String(xhr.responseText).slice(0, 600); } catch (e) {}
            });

            if (url.indexOf('pg-proxy.playmelonpg.com') === -1) {
                return xhrSend.apply(this, arguments);
            }
            var body = arguments[0];
            ensureAuth().then(function (auth) {
                if (auth && auth.jwt) {
                    try { setHeader.call(xhr, 'authorization', 'Bearer ' + auth.jwt); } catch (err) {}
                }
                xhrSend.call(xhr, body);
            });
        };
    }

    window.addEventListener('message', function (event) {
        var data = event.data;
        if (!data || typeof data !== 'object' || data.source !== GAME_SOURCE) {
            if (data && typeof data === 'object' && data.source === HOST_SOURCE) {
                window.__melonHost.push({ module: data.module, submodule: data.submodule, event: data.event, type: data.type, at: Date.now() });
            }
            return;
        }
        window.__melonSdk.push({ module: data.module, submodule: data.submodule, event: data.event, type: data.type, at: Date.now() });
        if (window.__melonSdk.length > 400) window.__melonSdk.shift();
        try {
            handle(data);
        } catch (err) {
            console.warn('[host-shim] failed to answer', data, err);
        }
    }, false);

    console.log('[host-shim] acting as melonsandbox.com parent for the self-hosted build');
})();
