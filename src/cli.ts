import { probeChipnetEndpoints } from './endpointProbe.js';

const command = process.argv[2];

if (command !== 'probe') {
  console.error('usage: npm run probe:chipnet');
  process.exitCode = 2;
} else {
  const results = await probeChipnetEndpoints();
  for (const result of results) {
    console.log(
      JSON.stringify({
        endpoint: result.endpoint.name,
        host: result.endpoint.host,
        port: result.endpoint.port,
        transport: result.endpoint.transport,
        ok: result.ok,
        chainHeight: result.chainHeight,
        error: result.error,
      }),
    );
  }

  if (results.every((result) => !result.ok)) process.exitCode = 1;
}
