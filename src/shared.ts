import { Either, tryCatch as tryCatchE } from 'fp-ts/lib/Either';
import { constant, constVoid } from 'fp-ts/lib/function';
import {NonEmptyArray} from 'fp-ts/lib/NonEmptyArray';
import { chain, fromEither, fromPredicate, mapNullable, Option, tryCatch } from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/pipeable';
import {Forest, Tree} from 'fp-ts/lib/Tree';
import {
  GQL_CLIENT_MESSAGE,
  GQL_CONNECTION_INIT,
  GQL_SERVER_MESSAGE,
  GQL_STOP,
  isGQLServerMessage
} from './GQLMessage';

export interface ClientError extends NonEmptyArray<Tree<string>> {}

const empty: Array<never> = []

export function tree<A>(value: A, forest: Forest<A> = empty): Tree<A> {
  return {
    value,
    forest
  }
}

export function graphqlToClientError(error: GraphQLError): Tree<string> {
  return tree(error.message, [
    tree('locations:', error.locations.map(location => tree(`line: ${location.line}, column: ${location.column}`))),
    tree('paths:', error.path.map(p => tree(p)))
  ]);
}

export interface GraphQLError {
  message: string;
  locations: {
    line: number;
    column: number;
  }[];
  path: string[];
}

export function isObject(obj: unknown): obj is object {
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
        [tree(`Message must be a JSON-parsable object. Got: ${payload}`)]
  );
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

export function getStopMessage(id: number): string {
  return JSON.stringify({
    id,
    type: GQL_STOP
  });
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

export interface WebSocketEventListeners {
  close: Array<(ev: CloseEvent) => void>;
  error: Array<(ev: Event) => void>;
  message: Array<(message: MessageEvent) => void>;
  open: Array<(ev: Event) => void>;
}

export const DEFAULT_EVENT_LISTENERS: WebSocketEventListeners = {
  open: [],
  close: [],
  message: [],
  error: []
};
