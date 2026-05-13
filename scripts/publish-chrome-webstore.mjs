#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const uploadBaseUrl = 'https://www.googleapis.com/upload/chromewebstore/v1.1/items';
const publishBaseUrl = 'https://www.googleapis.com/chromewebstore/v1.1/items';
const allowedPublishTargets = new Set(['default', 'trustedTesters']);

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Valeur manquante pour ${optionName}.`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    extensionId: '',
    publish: false,
    publishTarget: 'default',
    zipPath: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const optionName = argv[index];
    if (optionName === '--zip') {
      options.zipPath = readOptionValue(argv, index, optionName);
      index += 1;
      continue;
    }
    if (optionName === '--extension-id') {
      options.extensionId = readOptionValue(argv, index, optionName);
      index += 1;
      continue;
    }
    if (optionName === '--publish-target') {
      options.publishTarget = readOptionValue(argv, index, optionName);
      index += 1;
      continue;
    }
    if (optionName === '--publish') {
      options.publish = true;
      continue;
    }
    if (optionName === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Argument inconnu: ${optionName}`);
  }

  if (!options.zipPath) {
    throw new Error('Argument requis: --zip <chemin-du-zip>.');
  }
  if (!allowedPublishTargets.has(options.publishTarget)) {
    throw new Error(`Cible de publication invalide: ${options.publishTarget}.`);
  }
  return options;
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Secret GitHub manquant: ${name}.`);
  }
  return value;
}

function summarizeItemErrors(payload) {
  const itemErrors = Array.isArray(payload?.itemError) ? payload.itemError : [];
  if (itemErrors.length === 0) return '';
  return itemErrors
    .map((itemError) => (typeof itemError === 'string' ? itemError : JSON.stringify(itemError)))
    .join('\n');
}

function summarizePublishStatus(payload) {
  const publishStatuses = Array.isArray(payload?.status) ? payload.status : [];
  if (!publishStatuses.includes('OK')) {
    throw new Error(`Publication Chrome Web Store refusee: ${publishStatuses.join(', ') || JSON.stringify(payload)}`);
  }
  return publishStatuses.join(', ');
}

async function readJsonResponse(response) {
  const responseText = await response.text();
  if (!responseText) return {};
  try {
    return JSON.parse(responseText);
  } catch (_error) {
    return { raw: responseText };
  }
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const details = summarizeItemErrors(payload) || payload?.error_description || payload?.error || payload?.raw || JSON.stringify(payload);
    throw new Error(`API Chrome Web Store HTTP ${response.status}: ${details}`);
  }
  return payload;
}

async function fetchAccessToken({ clientId, clientSecret, refreshToken }) {
  const payload = await requestJson(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!payload.access_token) {
    throw new Error('Token OAuth Chrome Web Store introuvable dans la reponse Google.');
  }
  return payload.access_token;
}

async function uploadPackage({ accessToken, extensionId, zipPath }) {
  const zipBuffer = await readFile(zipPath);
  const payload = await requestJson(`${uploadBaseUrl}/${encodeURIComponent(extensionId)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/zip',
      'x-goog-api-version': '2',
    },
    body: zipBuffer,
  });

  const itemErrors = summarizeItemErrors(payload);
  if (payload.uploadState !== 'SUCCESS' || itemErrors) {
    throw new Error(`Upload Chrome Web Store refuse: ${itemErrors || JSON.stringify(payload)}`);
  }
  return payload;
}

async function publishPackage({ accessToken, extensionId, publishTarget }) {
  const publishUrl = new URL(`${publishBaseUrl}/${encodeURIComponent(extensionId)}/publish`);
  publishUrl.searchParams.set('publishTarget', publishTarget);
  return requestJson(publishUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-goog-api-version': '2',
    },
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const zipStats = await stat(options.zipPath);
  if (!zipStats.isFile() || zipStats.size === 0) {
    throw new Error(`Package invalide: ${options.zipPath}.`);
  }

  console.log(`Package verifie: ${options.zipPath} (${zipStats.size} octets).`);
  if (options.dryRun) {
    console.log('Dry-run: aucun appel Chrome Web Store effectue.');
    return;
  }

  const extensionId = options.extensionId || getRequiredEnv('CHROME_EXTENSION_ID');
  const accessToken = await fetchAccessToken({
    clientId: getRequiredEnv('CHROME_CLIENT_ID'),
    clientSecret: getRequiredEnv('CHROME_CLIENT_SECRET'),
    refreshToken: getRequiredEnv('CHROME_REFRESH_TOKEN'),
  });

  await uploadPackage({ accessToken, extensionId, zipPath: options.zipPath });
  console.log(`Package uploade sur Chrome Web Store pour ${extensionId}.`);

  if (!options.publish) {
    console.log('Publication non demandee: le paquet reste en brouillon Chrome Web Store.');
    return;
  }

  const publishPayload = await publishPackage({ accessToken, extensionId, publishTarget: options.publishTarget });
  const publishStatus = summarizePublishStatus(publishPayload);
  console.log(`Publication demandee: ${publishStatus}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});