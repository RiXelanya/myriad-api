import {ApiPromise, WsProvider} from '@polkadot/api';

export async function polkadotApi(): Promise<ApiPromise> {
  const wsProvider = new WsProvider('wss://rpc.myriad.systems')
  const api = await new ApiPromise({provider: wsProvider}).isReadyOrError

  return api
}
