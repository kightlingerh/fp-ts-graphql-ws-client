import { Either } from 'fp-ts/lib/Either';
import { Option } from 'fp-ts/lib/Option';
import { Error } from 'tslint/lib/error';
import { GQL_CLIENT_MESSAGE, GQL_SERVER_MESSAGE } from './GQLMessage';
import { ConnectionError, WebSocketEventListeners } from './WebSocket';
export interface GraphQLError {
    message: string;
    locations: {
        line: number;
        column: number;
    }[];
    path: string[];
}
export interface OperationError {
    graphqlErrors: GraphQLError[];
    otherErrors: Error[];
}
export interface ClientError extends OperationError {
    connectionError: Option<ConnectionError>;
}
export declare function isObject(obj: any): obj is object;
export declare function parseReceivedMessage(payload: string): Either<ClientError, object>;
export declare function getClientError({ connectionError, graphqlErrors, otherErrors }: Partial<ClientError>): ClientError;
export declare function constructMessage(id: number | undefined, type: GQL_CLIENT_MESSAGE, payload?: any): Option<string>;
export declare function getConnectionInitMessage(connectionParams?: any): Option<string>;
export declare function sendRawMessage(ws: WebSocket): (message: string) => () => void;
export declare function extractTypeFromParsedMessage(parsedMessage: Either<ClientError, object>): Option<GQL_SERVER_MESSAGE>;
export declare const lazyIOVoid: import("fp-ts/lib/function").Lazy<() => void>;
export declare const DEFAULT_EVENT_LISTENERS: WebSocketEventListeners;
