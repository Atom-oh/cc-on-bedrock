'use strict';

/**
 * DevEnv Auth Lambda@Edge (Viewer Request)
 *
 * Authenticates users via Cognito OAuth before they can access *.dev.atomai.click.
 * Ensures each user can only access their own subdomain by injecting X-Auth-User header.
 *
 * Flow:
 *   1. Has valid _devenv_auth cookie? → verify HMAC, check subdomain, inject X-Auth-User, pass
 *   2. Is /_auth/callback? → exchange code for tokens, set cookie, redirect to original URL
 *   3. No cookie? → redirect to Cognito Hosted UI
 *
 * Config: Static values are hardcoded at CDK synth time. Dynamic values (Cognito client ID,
 * secrets) are stored in SSM Parameter Store and read on cold start, since Lambda@Edge
 * cannot use environment variables and EdgeFunction stacks can't resolve cross-region tokens.
 */

// Static config (known at CDK synth time, no CDK tokens)
const STATIC_CONFIG = {
  cognitoDomain: '__COGNITO_DOMAIN__',
  devDomain: '__DEV_DOMAIN__',
  callbackUrl: '__CALLBACK_URL__',
  ssmParamName: '/cc-on-bedrock/devenv-auth-config',
  ssmRegion: '__SSM_REGION__',
};

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

const COOKIE_NAME = '_devenv_auth';
const COOKIE_MAX_AGE = 8 * 60 * 60; // 8 hours

// Config cache (loaded from SSM on cold start)
let CONFIG = null;
let configPromise = null;

// JWKS cache (persists across warm Lambda invocations)
let jwksCache = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL = 3600 * 1000; // 1 hour

// ─── Config Loading from SSM ───

async function loadConfig() {
  if (CONFIG) return CONFIG;
  if (configPromise) return configPromise;

  configPromise = (async () => {
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const client = new SSMClient({ region: STATIC_CONFIG.ssmRegion });
    const res = await client.send(new GetParameterCommand({
      Name: STATIC_CONFIG.ssmParamName,
      WithDecryption: true,
    }));
    const dynamic = JSON.parse(res.Parameter.Value);
    CONFIG = {
      ...STATIC_CONFIG,
      clientId: dynamic.clientId,
      clientSecret: dynamic.clientSecret,
      cookieSecret: dynamic.cookieSecret,
      userPoolId: dynamic.userPoolId,
      region: dynamic.region,
    };
    return CONFIG;
  })();

  return configPromise;
}

// ─── HMAC Cookie Signing ───

function signCookie(payload, secret) {
  const data = JSON.stringify(payload);
  const encoded = Buffer.from(data).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyCookie(cookieValue, secret) {
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ─── HTTPS Helper ───

function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ statusCode: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

// ─── JWT Decode & Verify ───

function decodeJwtHeader(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
}

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

async function fetchJwks(config) {
  const now = Date.now();
  if (jwksCache && (now - jwksCacheTime) < JWKS_CACHE_TTL) return jwksCache;

  const url = `https://cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}/.well-known/jwks.json`;
  const parsed = new URL(url);
  const res = await httpsRequest({ hostname: parsed.hostname, path: parsed.pathname, method: 'GET' });
  if (res.statusCode === 200 && res.body.keys) {
    jwksCache = res.body.keys;
    jwksCacheTime = now;
    return jwksCache;
  }
  throw new Error(`Failed to fetch JWKS: ${res.statusCode}`);
}

function verifyWithKey(token, jwk) {
  const parts = token.split('.');
  const signatureInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const isValid = crypto.createVerify('RSA-SHA256').update(signatureInput).verify(pubKey, signature);
  if (!isValid) throw new Error('Invalid token signature');
  return decodeJwtPayload(token);
}

async function verifyIdToken(idToken, config) {
  const header = decodeJwtHeader(idToken);
  let keys = await fetchJwks(config);
  let key = keys.find(k => k.kid === header.kid);
  if (!key) {
    // Key rotation — refresh JWKS
    jwksCache = null;
    keys = await fetchJwks(config);
    key = keys.find(k => k.kid === header.kid);
    if (!key) throw new Error('Key not found in JWKS');
  }
  return verifyWithKey(idToken, key);
}

// ─── Cookie Parsing ───

function parseCookies(headers) {
  const cookies = {};
  if (headers.cookie) {
    for (const h of headers.cookie) {
      for (const pair of h.value.split(';')) {
        const [name, ...rest] = pair.trim().split('=');
        if (name) cookies[name.trim()] = rest.join('=');
      }
    }
  }
  return cookies;
}

function getHostSubdomain(headers) {
  if (!headers.host || !headers.host[0]) return null;
  const host = headers.host[0].value;
  const suffix = `.${STATIC_CONFIG.devDomain}`;
  if (!host.endsWith(suffix)) return null;
  return host.slice(0, -suffix.length);
}

// ─── Response Helpers ───

function redirectResponse(location, setCookieHeader) {
  const response = {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: location }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
    },
  };
  if (setCookieHeader) {
    response.headers['set-cookie'] = [{ key: 'Set-Cookie', value: setCookieHeader }];
  }
  return response;
}

function forbiddenResponse(message) {
  return {
    status: '403',
    statusDescription: 'Forbidden',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'application/json' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-cache' }],
    },
    body: JSON.stringify({ error: message }),
  };
}

// ─── Main Handler ───

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const uri = request.uri;

  // Health check passthrough (NLB health checks don't carry cookies)
  if (uri === '/health' || uri === '/nginx-status') {
    return request;
  }

  // Load config from SSM (cached after first cold start)
  const config = await loadConfig();

  const subdomain = getHostSubdomain(headers);

  // Handle OAuth callback — auth.dev.atomai.click/_auth/callback
  if (uri === '/_auth/callback' && subdomain === 'auth') {
    return handleCallback(request, config);
  }

  // For non-callback requests, require a valid subdomain
  if (!subdomain || subdomain === 'auth') {
    return forbiddenResponse('Invalid subdomain');
  }

  // Check for existing auth cookie
  const cookies = parseCookies(headers);
  const cookieValue = cookies[COOKIE_NAME];
  if (cookieValue) {
    const payload = verifyCookie(cookieValue, config.cookieSecret);
    if (payload && payload.subdomain) {
      // Enforce: cookie subdomain must match the requested subdomain
      if (payload.subdomain !== subdomain) {
        return forbiddenResponse('Not authorized for this environment');
      }
      // Inject X-Auth-User header for Nginx to verify
      request.headers['x-auth-user'] = [{ key: 'X-Auth-User', value: payload.subdomain }];
      return request;
    }
  }

  // No valid cookie — redirect to Cognito login
  const originalUrl = `https://${headers.host[0].value}${uri}${request.querystring ? '?' + request.querystring : ''}`;
  const state = Buffer.from(originalUrl).toString('base64url');
  const authorizeUrl = `https://${config.cognitoDomain}/oauth2/authorize?` +
    querystring.stringify({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: 'openid email profile',
      state,
    });

  return redirectResponse(authorizeUrl);
};

// ─── OAuth Callback Handler ───

async function handleCallback(request, config) {
  const qs = querystring.parse(request.querystring || '');
  const { code, state } = qs;

  if (!code) {
    return forbiddenResponse('Missing authorization code');
  }

  // Exchange code for tokens
  const tokenBody = querystring.stringify({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.callbackUrl,
    code,
  });

  const tokenRes = await httpsRequest({
    hostname: config.cognitoDomain,
    path: '/oauth2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(tokenBody),
    },
  }, tokenBody);

  if (tokenRes.statusCode !== 200 || !tokenRes.body.id_token) {
    console.error('Token exchange failed:', tokenRes.statusCode, JSON.stringify(tokenRes.body));
    return forbiddenResponse('Authentication failed');
  }

  // Verify ID token and extract claims
  let claims;
  try {
    claims = await verifyIdToken(tokenRes.body.id_token, config);
  } catch (err) {
    console.error('ID token verification failed:', err.message);
    return forbiddenResponse('Token verification failed');
  }

  const userSubdomain = claims['custom:subdomain'];
  if (!userSubdomain) {
    return forbiddenResponse('No subdomain assigned to this user');
  }

  // Create signed cookie
  const now = Math.floor(Date.now() / 1000);
  const cookiePayload = {
    sub: claims.sub,
    email: claims.email,
    subdomain: userSubdomain,
    exp: now + COOKIE_MAX_AGE,
  };
  const cookieValue = signCookie(cookiePayload, config.cookieSecret);
  const setCookie = `${COOKIE_NAME}=${cookieValue}; Domain=.${config.devDomain}; Path=/; Max-Age=${COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`;

  // Redirect to original URL from state parameter
  let redirectUrl = `https://${userSubdomain}.${config.devDomain}/`;
  if (state) {
    try {
      redirectUrl = Buffer.from(state, 'base64url').toString();
      const parsed = new URL(redirectUrl);
      if (!parsed.hostname.endsWith(`.${config.devDomain}`)) {
        redirectUrl = `https://${userSubdomain}.${config.devDomain}/`;
      }
    } catch { /* use default */ }
  }

  return redirectResponse(redirectUrl, setCookie);
}
