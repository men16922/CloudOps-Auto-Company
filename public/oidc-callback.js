// Same-origin OIDC popup callback. The code is useless without the PKCE verifier held in the app's memory.
const params = new URLSearchParams(window.location.search);
const message = { type: 'cloudops-oidc-callback', state: params.get('state'), code: params.get('code'), error: params.get('error') };
window.history.replaceState(null, '', window.location.pathname);
const channel = new BroadcastChannel('cloudops-oidc');
channel.postMessage(message);
channel.close();
window.close();
