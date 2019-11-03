import { Either, tryCatch as tryCatchE } from 'fp-ts/lib/Either';
import { constant, constVoid } from 'fp-ts/lib/function';
import { chain, fromEither, fromPredicate, mapNullable, none, Option, tryCatch } from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/pipeable';
import { GQL_CLIENT_MESSAGE, GQL_CONNECTION_INIT, GQL_SERVER_MESSAGE, isGQLServerMessage } from './GQLMessage';
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

export function isObject(obj: any): obj is object {
  return obj !== null && typeof obj === 'object';
}

export function parseReceivedMessage(payload: string): Either<ClientError, object> {
  return tryCatchE(
    () => {
      const result = JSON.parse(payload);
      if (isObject(result)) {
        return result;
      } else {
        throw new Error();
      }
    },
    () =>
      getClientError({
        otherErrors: [new Error(`Message must be a JSON-parsable object. Got: ${payload}`)]
      })
  );
}

export function getClientError({
  connectionError = none,
  graphqlErrors = [],
  otherErrors = []
}: Partial<ClientError>): ClientError {
  return {
    connectionError,
    graphqlErrors,
    otherErrors
  };
}

export function constructMessage(id: number | undefined, type: GQL_CLIENT_MESSAGE, payload?: any): Option<string> {
  return tryCatch(() =>
    JSON.stringify({
      id,
      type,
      payload
    })
  );
}

export function getConnectionInitMessage(connectionParams?: any) {
  return constructMessage(undefined, GQL_CONNECTION_INIT, connectionParams);
}

export function sendRawMessage(ws: WebSocket) {
  return (message: string) => () => ws.send(message);
}

export function extractTypeFromParsedMessage(parsedMessage: Either<ClientError, object>): Option<GQL_SERVER_MESSAGE> {
  return pipe(
    fromEither<ClientError, { type?: string }>(parsedMessage),
    mapNullable(message => message.type),
    chain(fromPredicate(isGQLServerMessage))
  );
}

export const lazyIOVoid = constant(constVoid);

export const DEFAULT_EVENT_LISTENERS: WebSocketEventListeners = {
  open: [],
  close: [],
  message: [],
  error: []
};
