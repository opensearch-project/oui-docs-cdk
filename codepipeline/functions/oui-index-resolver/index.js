var LATEST_VERSION = "1.0";
var USE_LATEST = true;

function handler(event) {
    var parts = event.request.uri.split('/');

    if (parts[1] === 'versions.json') {
        return event.request;
    }

    if (event.request.uri[0] !== '/') parts.unshift('');

    // With /1.0, without a trailing `/`, the docs confuse baseURL
    if (/^\d+\.\d+$/.test(parts[1]) && parts.length === 2) {
        parts.push('');
        return {
            statusCode: 308,
            statusDescription: 'Permanent Redirect',
            headers: {
                "location": {
                    "value": parts.join('/')
                },
                "cache-control": {
                    "value": "max-age=604800"
                },
            }
        };
    }

    if (!/^\d+\.\d+$/.test(parts[1]) && (!USE_LATEST || parts[1] !== 'latest')) {
        parts.splice(1, 0, USE_LATEST ? 'latest' : LATEST_VERSION);

        // If landing only with domain name, add trailing '/'
        if (parts.length === 2) parts.push('');

        return {
            statusCode: 307,
            statusDescription: 'Temporary Redirect',
            headers: {
                "location": {
                    "value": parts.join('/')
                },
                "cache-control": {
                    "value": "max-age=15"
                },
            }
        };
    }

    var lastPart = parts[parts.length - 1];
    if (lastPart) lastPart = lastPart.trim();
    if (!lastPart) parts[parts.length - 1] = 'index.html';
    else if (!/^.+\..+$/.test(lastPart) || !isNaN(lastPart)) parts.push('index.html');

    event.request.uri = parts.join('/');

    return event.request;
}