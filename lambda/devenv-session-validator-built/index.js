'use strict';

/**
 * DevEnv Session Validator — Lambda@Edge (Viewer Request)
 *
 * Validates NextAuth session cookie for *.dev.atomai.click requests.
 * Ensures each user can only access their own subdomain (X-Auth-User injection).
 * Dashboard requests pass through untouched.
 *
 * Replaces the previous Cognito OAuth Lambda@Edge (devenv-auth-edge) with a
 * simpler cookie-only validator — no OAuth flow, no JWKS, no token exchange.
 *
 * Config: NEXTAUTH_SECRET is stored in SSM Parameter Store and read on cold start.
 * Static values (dev.atomai.click, https://cconbedrock-dashboard.atomai.click, ap-northeast-2) are baked in at CDK synth time.
 */

const crypto = require('crypto');
const https = require('https');

// Static config (replaced by sed at CDK synth time)
const DEV_DOMAIN = 'dev.atomai.click';
const DASHBOARD_LOGIN_URL = 'https://cconbedrock-dashboard.atomai.click/login';
const SSM_REGION = 'ap-northeast-2';
const SSM_PARAM_NAME = '/cc-on-bedrock/nextauth-secret';

// Config cache (loaded from SSM on cold start)
let encryptionKey = null;
let configPromise = null;

// ─── SSM Config Loading ───

function loadConfig() {
  if (configPromise) return configPromise;
  configPromise = new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      Action: 'GetParameter',
      Name: SSM_PARAM_NAME,
      WithDecryption: 'true',
      Version: '2014-11-06',
    });
    const options = {
      hostname: `ssm.${SSM_REGION}.amazonaws.com`,
      path: `/?${params}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AmazonSSM.GetParameter' },
    };
    // Use AWS SDK-style request signing via IAM role credentials
    const AWS = require('/var/runtime/node_modules/aws-sdk');
    const ssm = new AWS.SSM({ region: SSM_REGION });
    ssm.getParameter({ Name: SSM_PARAM_NAME, WithDecryption: true }, (err, data) => {
      if (err) { configPromise = null; return reject(err); }
      const secret = data.Parameter.Value;
      // Derive encryption key same as NextAuth: HKDF(SHA-256, secret, '', info, 32)
      encryptionKey = crypto.hkdfSync('sha256', secret, '', 'NextAuth.js Generated Encryption Key', 32);
      resolve(encryptionKey);
    });
  });
  return configPromise;
}

// ─── JWE Decryption (NextAuth v4 uses A256GCM with direct key agreement) ───

function decryptNextAuthJwe(token) {
  if (!encryptionKey) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 5) return null;

    const [headerB64, encKeyB64, ivB64, ciphertextB64, tagB64] = parts;
    const header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));

    // NextAuth uses "dir" key management (direct encryption with derived key)
    if (header.alg !== 'dir' || header.enc !== 'A256GCM') return null;

    const iv = base64urlDecode(ivB64);
    const ciphertext = base64urlDecode(ciphertextB64);
    const tag = base64urlDecode(tagB64);

    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    // AAD is the base64url-encoded header per JWE spec
    decipher.setAAD(Buffer.from(headerB64, 'ascii'));

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (e) {
    return null;
  }
}

function base64urlDecode(str) {
  // Pad base64url to base64 and decode
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ─── Cookie Parsing ───

function parseCookies(headers) {
  const cookies = {};
  if (!headers.cookie) return cookies;
  for (const entry of headers.cookie) {
    for (const pair of entry.value.split(';')) {
      const [name, ...rest] = pair.trim().split('=');
      if (name) cookies[name.trim()] = rest.join('=').trim();
    }
  }
  return cookies;
}

// ─── Response Helpers ───

function redirectToLogin(originalHost, request) {
  const originalUrl = `https://${originalHost}${request.uri}${request.querystring ? '?' + request.querystring : ''}`;
  const loginUrl = `${DASHBOARD_LOGIN_URL}?callbackUrl=${encodeURIComponent(originalUrl)}`;
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: loginUrl }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-cache, no-store' }],
    },
  };
}

function forbidden(message) {
  return {
    status: '403',
    statusDescription: 'Forbidden',
    headers: { 'content-type': [{ key: 'Content-Type', value: 'text/plain' }] },
    body: message || 'Forbidden',
  };
}

// ─── Handler ───

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const host = (headers.host && headers.host[0].value) || '';

  // Pass through non-devenv requests (dashboard traffic)
  if (!host.endsWith(`.${DEV_DOMAIN}`)) return request;

  // Health check bypass (NLB health checks)
  const uri = request.uri;
  if (uri === '/health' || uri === '/nginx-status') return request;

  // Extract subdomain from Host header
  const subdomain = host.slice(0, -(DEV_DOMAIN.length + 1));
  if (!subdomain || subdomain.includes('.')) return forbidden('Invalid subdomain');

  // Load encryption key from SSM (cached after cold start)
  try {
    await loadConfig();
  } catch (e) {
    console.error('Failed to load config:', e);
    return { status: '500', statusDescription: 'Internal Server Error', body: 'Auth config unavailable' };
  }

  // Read NextAuth session cookie
  const cookies = parseCookies(headers);
  const sessionToken = cookies['__Secure-next-auth.session-token'] || cookies['next-auth.session-token'];
  if (!sessionToken) return redirectToLogin(host, request);

  // Decrypt JWE token
  const payload = decryptNextAuthJwe(sessionToken);
  if (!payload) return redirectToLogin(host, request);

  // Check token expiration
  if (payload.exp && Date.now() / 1000 > payload.exp) return redirectToLogin(host, request);

  // Subdomain ownership check: user can only access their own environment
  if (payload.subdomain !== subdomain) return forbidden('Not authorized for this environment');

  // Inject X-Auth-User header for Nginx defense-in-depth
  request.headers['x-auth-user'] = [{ key: 'X-Auth-User', value: subdomain }];

  return request;
};
