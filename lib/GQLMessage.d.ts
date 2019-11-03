export declare const GQL_CONNECTION_INIT: "connection_init";
export declare type GQL_CONNECTION_INIT = typeof GQL_CONNECTION_INIT;
export declare const GQL_CONNECTION_ACK: "connection_ack";
export declare type GQL_CONNECTION_ACK = typeof GQL_CONNECTION_ACK;
export declare const GQL_CONNECTION_ERROR: "connection_error";
export declare type GQL_CONNECTION_ERROR = typeof GQL_CONNECTION_ERROR;
export declare const GQL_CONNECTION_KEEP_ALIVE: "ka";
export declare type GQL_CONNECTION_KEEP_ALIVE = typeof GQL_CONNECTION_KEEP_ALIVE;
export declare const GQL_CONNECTION_TERMINATE: "connection_terminate";
export declare type GQL_CONNECTION_TERMINATE = typeof GQL_CONNECTION_TERMINATE;
export declare const GQL_START: "start";
export declare type GQL_START = typeof GQL_START;
export declare const GQL_DATA: "data";
export declare type GQL_DATA = typeof GQL_DATA;
export declare const GQL_ERROR: "error";
export declare type GQL_ERROR = typeof GQL_ERROR;
export declare const GQL_COMPLETE: "complete";
export declare type GQL_COMPLETE = typeof GQL_COMPLETE;
export declare const GQL_STOP: "stop";
export declare type GQL_STOP = typeof GQL_STOP;
export declare type GQL_MESSAGE = GQL_CONNECTION_INIT | GQL_CONNECTION_ACK | GQL_CONNECTION_ERROR | GQL_CONNECTION_KEEP_ALIVE | GQL_CONNECTION_TERMINATE | GQL_START | GQL_DATA | GQL_ERROR | GQL_COMPLETE | GQL_STOP;
export declare type GQL_CLIENT_MESSAGE = GQL_CONNECTION_INIT | GQL_CONNECTION_TERMINATE | GQL_START | GQL_STOP;
export declare type GQL_SERVER_MESSAGE = GQL_CONNECTION_ACK | GQL_CONNECTION_ERROR | GQL_CONNECTION_KEEP_ALIVE | GQL_DATA | GQL_ERROR | GQL_COMPLETE;
export declare type GQL_DATA_MESSAGE = GQL_DATA | GQL_ERROR | GQL_COMPLETE;
export declare function isGQLServerMessage(str: string): str is GQL_SERVER_MESSAGE;
