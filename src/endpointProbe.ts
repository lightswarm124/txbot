import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumTcpSocket } from '@electrum-cash/tcp-socket';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';

import { CHIPNET_ENDPOINTS, type ElectrumEndpoint } from './config.js';

export type EndpointProbeResult = {
  endpoint: ElectrumEndpoint;
  ok: boolean;
  chainHeight?: number;
  error?: string;
};

export async function probeEndpoint(
  endpoint: ElectrumEndpoint,
): Promise<EndpointProbeResult> {
  const socket =
    endpoint.transport === 'wss'
      ? new ElectrumWebSocket(endpoint.host, {
          port: endpoint.port,
          encrypted: true,
        })
      : new ElectrumTcpSocket(endpoint.host, {
          port: endpoint.port,
          encrypted: true,
        });
  const client = new ElectrumClient(
    'CauldronTxBot',
    '1.4.1',
    socket,
  );

  try {
    await client.connect();
    const header = (await client.request(
      'blockchain.headers.subscribe',
    )) as { height?: number };
    return {
      endpoint,
      ok: Number.isInteger(header?.height),
      chainHeight: header?.height,
    };
  } catch (error) {
    return {
      endpoint,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.disconnect(true).catch(() => undefined);
  }
}

export async function probeChipnetEndpoints(): Promise<EndpointProbeResult[]> {
  const results: EndpointProbeResult[] = [];
  for (const endpoint of CHIPNET_ENDPOINTS) {
    results.push(await probeEndpoint(endpoint));
  }
  return results;
}
