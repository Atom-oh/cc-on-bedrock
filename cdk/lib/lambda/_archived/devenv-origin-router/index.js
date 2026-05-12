'use strict';

/**
 * DevEnv Origin Router — Lambda@Edge (Origin Request)
 *
 * Routes requests to the correct origin based on Host header:
 *   *.dev.atomai.click → NLB (Nginx → code-server)
 *   everything else    → ALB (Next.js dashboard, default origin)
 *
 * Static values (__DEV_DOMAIN__, __SSM_REGION__) are baked in at CDK synth time.
 * Dynamic values (NLB DNS, CF secret) are loaded from SSM on cold start because
 * they come from CloudFormation tokens (Fn::ImportValue, Secrets Manager) that
 * only resolve at deploy time, after Lambda bundling has already run.
 *
 * Lambda@Edge origin-request can dynamically override the origin without
 * pre-declaring it in the CloudFront distribution — official AWS pattern.
 */

const DEV_DOMAIN = '__DEV_DOMAIN__';
const SSM_REGION = '__SSM_REGION__';
const SSM_PARAM_NAME = '/cc-on-bedrock/devenv-origin-config';

// Config cache (loaded from SSM on cold start)
let nlbDns = null;
let cfSecret = null;
let configPromise = null;

function loadConfig() {
  if (configPromise) return configPromise;
  configPromise = new Promise((resolve, reject) => {
    const AWS = require('/var/runtime/node_modules/aws-sdk');
    const ssm = new AWS.SSM({ region: SSM_REGION });
    ssm.getParameter({ Name: SSM_PARAM_NAME, WithDecryption: true }, (err, data) => {
      if (err) { configPromise = null; return reject(err); }
      const config = JSON.parse(data.Parameter.Value);
      nlbDns = config.nlbDns;
      cfSecret = config.cfSecret;
      resolve();
    });
  });
  return configPromise;
}

exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const host = (request.headers.host && request.headers.host[0].value) || '';

  if (host.endsWith(`.${DEV_DOMAIN}`)) {
    // Load config from SSM (cached after cold start)
    await loadConfig();

    // Override origin to NLB for devenv traffic
    request.origin = {
      custom: {
        domainName: nlbDns,
        port: 80,
        protocol: 'http',
        path: '',
        sslProtocols: ['TLSv1.2'],
        readTimeout: 60,
        keepaliveTimeout: 5,
        customHeaders: {
          'x-custom-secret': [{ key: 'X-Custom-Secret', value: cfSecret }],
        },
      },
    };
    // Preserve original Host header for Nginx subdomain routing
    request.headers.host = [{ key: 'Host', value: host }];
  }

  return request;
};
