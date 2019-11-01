export const GQL_CONNECTION_INIT = 'connection_init' as const; // Client -> Server

export type GQL_CONNECTION_INIT = typeof GQL_CONNECTION_INIT;

export const GQL_CONNECTION_ACK = 'connection_ack' as const; // Server -> Client

export type GQL_CONNECTION_ACK = typeof GQL_CONNECTION_ACK;

export const GQL_CONNECTION_ERROR = 'connection_error' as const; // Server -> Client

export type GQL_CONNECTION_ERROR = typeof GQL_CONNECTION_ERROR;

export const GQL_CONNECTION_KEEP_ALIVE = 'ka' as const; // Server -> Client;

export type GQL_CONNECTION_KEEP_ALIVE = typeof GQL_CONNECTION_KEEP_ALIVE;

export const GQL_CONNECTION_TERMINATE = 'connection_terminate' as const; // Client -> Server

export type GQL_CONNECTION_TERMINATE = typeof GQL_CONNECTION_TERMINATE;

export const GQL_START = 'start' as const; // Client -> Server

export type GQL_START = typeof GQL_START;

export const GQL_DATA = 'data' as const; // Server -> Client

export type GQL_DATA = typeof GQL_DATA;

export const GQL_ERROR = 'error' as const; // Server -> Client

export type GQL_ERROR = typeof GQL_ERROR;

export const GQL_COMPLETE = 'complete' as const; // Server -> Client

export type GQL_COMPLETE = typeof GQL_COMPLETE;

export const GQL_STOP = 'stop' as const; // Client -> Server

export type GQL_STOP = typeof GQL_STOP;

export type GQL_MESSAGE =
  | GQL_CONNECTION_INIT
  | GQL_CONNECTION_ACK
  | GQL_CONNECTION_ERROR
  | GQL_CONNECTION_KEEP_ALIVE
  | GQL_CONNECTION_TERMINATE
  | GQL_START
  | GQL_DATA
  | GQL_ERROR
  | GQL_COMPLETE
  | GQL_STOP;

export type GQL_CLIENT_MESSAGE = GQL_CONNECTION_INIT | GQL_CONNECTION_TERMINATE | GQL_START | GQL_STOP;

export type GQL_SERVER_MESSAGE =
  | GQL_CONNECTION_ACK
  | GQL_CONNECTION_ERROR
  | GQL_CONNECTION_KEEP_ALIVE
  | GQL_DATA
  | GQL_ERROR
  | GQL_COMPLETE;

export type GQL_DATA_MESSAGE = GQL_DATA | GQL_ERROR | GQL_COMPLETE;

export function isGQLServerMessage(str: string): str is GQL_SERVER_MESSAGE {
  return [
    GQL_CONNECTION_ACK,
    GQL_CONNECTION_ERROR,
    GQL_CONNECTION_KEEP_ALIVE,
    GQL_DATA,
    GQL_CONNECTION_ERROR,
    GQL_COMPLETE
  ].includes(str as any);
}
