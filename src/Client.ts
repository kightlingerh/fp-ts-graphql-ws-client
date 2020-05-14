import { sequenceT } from 'fp-ts/lib/Apply';
import { now } from 'fp-ts/lib/Date';
import { Either, isRight, left, right } from 'fp-ts/lib/Either';
import { constant, flow, FunctionN } from 'fp-ts/lib/function';
import { IO } from 'fp-ts/lib/IO';
import * as io from 'fp-ts/lib/IO';
import * as o from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/pipeable';
import * as te from 'fp-ts/lib/TaskEither';
import { GQL_COMPLETE, GQL_CONNECTION_KEEP_ALIVE, GQL_DATA, GQL_START } from './GQLMessage';
import {
  ClientError,
  constructMessage,
  extractTypeFromParsedMessage,
  getStopMessage,
  GraphQLError, graphqlToClientError,
  lazyIOVoid,
  parseReceivedMessage,
  sendRawMessage, tree, WebSocketEventListeners
} from './shared';
import { ConnectionError, getWebSocket, WebSocketConfig } from './WebSocket';

export interface ClientConfig<WS extends typeof WebSocket> extends WebSocketConfig<WS> {
  inactivityTimeout: number;
}

export const DEFAULT_INACTIVITY_TIMEOUT = 30000;

export interface MutationInput<TVariables> {
  mutation: string; // Graphql mutation string
  operationName: string;
  variables: TVariables;
}

export interface QueryInput<TVariables> {
  query: string; // Graphql query string
  operationName: string;
  variables: TVariables;
}

export interface SubscriptionInput<TVariables, TData> {
  subscription: string; // Graphql subscription string
  operationName: string;
  variables: TVariables;
  onData: ResolveFunction<TData>
}

type OperationInput<T> = MutationInput<T> | QueryInput<T> | SubscriptionInput<T, any>;

type ClientData<T> = Either<ClientError, T>;

type ResolveFunction<T> = FunctionN<[ClientData<T>], void>;

type Unsubscribe = io.IO<void>;

interface ClientState {
  lastMessageReceivedTimestamp: o.Option<number>;
  outstandingOperations: Map<number, ResolveFunction<any>>;
}

const CLIENT_STATES: Map<string, ClientState> = new Map();

function constructClientState(): ClientState {
  return {
    lastMessageReceivedTimestamp: o.none,
    outstandingOperations: new Map()
  };
}

const getNextOperationId: IO<number> = (function() {
  let id = 0;
  return () => id++;
})();

function getClientState<WS extends typeof WebSocket>(config: ClientConfig<WS>): io.IO<ClientState> {
  return () => {
    const state = o.fromNullable(CLIENT_STATES.get(config.url));
    if (o.isSome(state)) {
      return state.value;
    } else {
      const newState = constructClientState();
      CLIENT_STATES.set(config.url, newState);
      return newState;
    }
  };
}

function extractIdFromParsedMessage(parsedMessage: ClientData<object>): o.Option<number> {
  return pipe(
    o.fromEither<ClientError, { id?: number }>(parsedMessage),
    o.mapNullable(message => message.id)
  );
}

function extractErrorsFromParsedMessage(parsedMessage: ClientData<object>): o.Option<GraphQLError[]> {
  return pipe(
    o.fromEither<ClientError, { payload?: { errors?: GraphQLError[] } }>(parsedMessage),
    o.mapNullable(message => message.payload),
    o.mapNullable(payload => payload.errors)
  );
}

function extractDataFromParsedMessage<T>(parsedMessage: ClientData<object>): o.Option<T> {
  return pipe(
    o.fromEither<ClientError, { payload?: { data?: T } }>(parsedMessage),
    o.mapNullable(message => message.payload),
    o.mapNullable(payload => payload.data)
  );
}

const optionSequenceT = sequenceT(o.option);

function getDataProcessor<WS extends typeof WebSocket>(config: ClientConfig<WS>) {
  return (receivedData: MessageEvent) => {
    const state = o.fromNullable(CLIENT_STATES.get(config.url));
    const parsedMessage: Either<ClientError, object> = parseReceivedMessage(receivedData.data);
    const id = extractIdFromParsedMessage(parsedMessage);
    const type = o.toUndefined(extractTypeFromParsedMessage(parsedMessage));
    const operation = pipe(
      optionSequenceT(state, id),
      o.chain(([st, extractedId]) => o.fromNullable(st.outstandingOperations.get(extractedId)))
    );
    switch (type) {
      case GQL_COMPLETE:
        pipe(
          optionSequenceT(state, id),
          o.fold(lazyIOVoid, ([st, extractedId]) => () => st.outstandingOperations.delete(extractedId))
        )();
        break;
      case GQL_DATA:
        if (isRight(parsedMessage) && o.isSome(operation)) {
          const errors = extractErrorsFromParsedMessage(parsedMessage);
          const data = extractDataFromParsedMessage(parsedMessage);
          const result: Either<ClientError, any> = o.isSome(errors)
            ? left(errors.value.map(graphqlToClientError) as ClientError)
            : o.isNone(data)
            ? left([tree(`no data received`)])
            : right(data.value);
          operation.value(result);
        }
        break;
      case GQL_CONNECTION_KEEP_ALIVE:
        pipe(
          state,
          o.fold(lazyIOVoid, st => () => {
            st.lastMessageReceivedTimestamp = o.some(now());
          })
        )();
        break;
    }
  };
}

function mergeEventListeners<WS extends typeof WebSocket>(
  config: ClientConfig<WS>,
  eventListeners: Partial<WebSocketEventListeners> = {}
): Partial<WebSocketEventListeners> {
  return {
    message: [...(eventListeners && eventListeners.message ? eventListeners.message : []), getDataProcessor(config)]
  };
}

function mergeDataProcessorToConfig<WS extends typeof WebSocket>(config: ClientConfig<WS>): ClientConfig<WS> {
  return {
    ...config,
    eventListeners: mergeEventListeners(config, config.eventListeners)
  };
}

function getInvalidOperationInputError<T>(input: OperationInput<T>): ClientError {
  return [tree(`Operation input must be JSON-parseable, received ${input}`)];
}

function getClientErrorFromConnectionError(connectionError: ConnectionError): ClientError {
  return [tree(`connection error: ${connectionError.type} at: ${connectionError.timestamp}`)]
}

function attachResolver<WS extends typeof WebSocket, TData>(
  config: ClientConfig<WS>,
  id: number,
  resolve: ResolveFunction<TData>
): io.IO<void> {
  return pipe(
    getClientState(config),
    io.chain(state => () => state.outstandingOperations.set(id, resolve))
  );
}

function getResolveWithInvalidInputIO<TVariables, TData>(
  input: OperationInput<TVariables>,
  resolve: ResolveFunction<TData>
) {
  return () => resolve(left(getInvalidOperationInputError(input)));
}

function getResolveWithClosedConnectionIO<TVariables, TData>(resolve: ResolveFunction<TData>) {
  return pipe(
    now,
    io.map(timestamp =>
      resolve(left([tree(`connection error: connection timed out at: ${timestamp}`)]))
    )
  );
}

const ioSequenceT = sequenceT(io.io);

function canSendMessage<WS extends typeof WebSocket>(ws: WebSocket, config: ClientConfig<WS>) {
  return (message: string): io.IO<o.Option<string>> =>
    pipe(
      ioSequenceT(getClientState(config), now),
      io.map(([state, time]) =>
        time > o.getOrElse(constant(time))(state.lastMessageReceivedTimestamp) + config.inactivityTimeout ||
        ws.readyState === ws.CLOSED
          ? o.none
          : o.some(message)
      )
    );
}

function attachIdToStartMessage(input: any) {
  return (id: number) => [id, constructMessage(id, GQL_START, input)] as readonly [number, o.Option<string>];
}

function foldMessageIntoIOResolver<WS extends typeof WebSocket, TVariables, TData>(
  config: ClientConfig<WS>,
  ws: WebSocket,
  input: OperationInput<TVariables>,
  resolve: ResolveFunction<TData>
) {
  return ([id, message]: readonly [number, o.Option<string>]): IO<void> => {
    return pipe(
      message,
      o.fold(
        constant(getResolveWithInvalidInputIO(input, resolve)),
        flow(
          canSendMessage(ws, config),
          io.chain(
            o.fold(
              constant(getResolveWithClosedConnectionIO(resolve)),
              flow(
                sendRawMessage(ws),
                io.apSecond(attachResolver(config, id, resolve))
              )
            )
          )
        )
      )
    );
  };
}

function mutateOrQuery<WS extends typeof WebSocket, TVariables, TData>(
  config: ClientConfig<WS>,
  input: MutationInput<TVariables> | QueryInput<TVariables>
): te.TaskEither<ClientError, TData> {
  return pipe(
    getWebSocket(mergeDataProcessorToConfig(config)),
    te.mapLeft(getClientErrorFromConnectionError),
    te.chain(ws => {
      return () =>
        new Promise(resolve => {
          pipe(
            getNextOperationId,
            io.map(attachIdToStartMessage(input)),
            io.chain(foldMessageIntoIOResolver(config, ws, input, resolve))
          )();
        });
    })
  );
}


function getUnsubscribe<WS extends typeof WebSocket>(config: ClientConfig<WS>, ws: WebSocket, id: number) {
  return pipe(
      getClientState(config),
      io.chain(state => {
        return () => {
          state.outstandingOperations.delete(id);
          ws.send(getStopMessage(id))
        }
      })
  )
}


function subscribe<WS extends typeof WebSocket, TVariables, TData>(
  config: ClientConfig<WS>,
  input: SubscriptionInput<TVariables, TData>
): te.TaskEither<ClientError, Unsubscribe> {
  return pipe(
    getWebSocket(mergeDataProcessorToConfig(config)),
    te.mapLeft(getClientErrorFromConnectionError),
    te.chain<ClientError, WebSocket, Unsubscribe>(ws => {
      return te.fromIOEither(
        pipe(
          getNextOperationId,
          io.map(attachIdToStartMessage(input)),
          io.chain(([id, message]) => {
            return () => {
              foldMessageIntoIOResolver(config, ws, input, input.onData)([id, message])();
              return getUnsubscribe(config, ws, id)
            }
          }),
          io.map(right)
        )
      );
    })
  );
}

export interface GraphqlClient {
  query: <TVariables, TData>(input: QueryInput<TVariables>) => te.TaskEither<ClientError, TData>;
  mutate: <TVariables, TData>(input: MutationInput<TVariables>) => te.TaskEither<ClientError, TData>;
  subscribe: <TVariables, TData>(
    input: SubscriptionInput<TVariables, TData>
  ) => te.TaskEither<ClientError, Unsubscribe>;
}

export function getGraphqlClient<WS extends typeof WebSocket>(config: ClientConfig<WS>): GraphqlClient {
  return {
    query: input => mutateOrQuery(config, input),
    mutate: input => mutateOrQuery(config, input),
    subscribe: input => subscribe(config, input)
  };
}
