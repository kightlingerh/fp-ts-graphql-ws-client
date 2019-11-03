export const GQL_CONNECTION_INIT = 'connection_init'; // Client -> Server
export const GQL_CONNECTION_ACK = 'connection_ack'; // Server -> Client
export const GQL_CONNECTION_ERROR = 'connection_error'; // Server -> Client
export const GQL_CONNECTION_KEEP_ALIVE = 'ka'; // Server -> Client;
export const GQL_CONNECTION_TERMINATE = 'connection_terminate'; // Client -> Server
export const GQL_START = 'start'; // Client -> Server
export const GQL_DATA = 'data'; // Server -> Client
export const GQL_ERROR = 'error'; // Server -> Client
export const GQL_COMPLETE = 'complete'; // Server -> Client
export const GQL_STOP = 'stop'; // Client -> Server
export function isGQLServerMessage(str) {
    return [
        GQL_CONNECTION_ACK,
        GQL_CONNECTION_ERROR,
        GQL_CONNECTION_KEEP_ALIVE,
        GQL_DATA,
        GQL_CONNECTION_ERROR,
        GQL_COMPLETE
    ].includes(str);
}
