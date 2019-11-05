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
  getClientError,
  GraphQLError,
  lazyIOVoid,
  parseReceivedMessage,
  sendRawMessage
} from './shared';
import { ConnectionError, getWebSocket, WebSocketConfig, WebSocketEventListeners } from './WebSocket';

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

export interface SubscriptionInput<TVariables> {
  subscription: string; // Graphql subscription string
  operationName: string;
  variables: TVariables;
}

type OperationInput<T> = MutationInput<T> | QueryInput<T> | SubscriptionInput<T>;

type ClientData<T> = Either<ClientError, T>;

type ResolveFunction<T> = FunctionN<[ClientData<T>], void>;

type Unsubscribe = io.IO<void>;

interface Observable<T> {
  subscribe(onNext: (value: T) => void): io.IO<Unsubscribe>;
}

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

function setClientState<WS extends typeof WebSocket>(config: ClientConfig<WS>, newState: ClientState): io.IO<void> {
  return () => {
    CLIENT_STATES.set(config.url, newState);
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
            ? left(getClientError({ graphqlErrors: errors.value }))
            : o.isNone(data)
            ? left(getClientError({ otherErrors: [new Error('No data received')] }))
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

function getInvalidOperationInputError<T>(input: OperationInput<T>) {
  return getClientError({
    otherErrors: [new Error(`Operation input must be JSON-parseable, received ${input}`)]
  });
}

function getClientErrorFromConnectionError(connectionError?: ConnectionError): ClientError {
  return getClientError({
    connectionError: o.fromNullable(connectionError)
  });
}

function attachResolver<WS extends typeof WebSocket, TData>(
  config: ClientConfig<WS>,
  id: number,
  resolve: ResolveFunction<TData>
): io.IO<void> {
  return pipe(
    getClientState(config),
    io.chain(state => {
      return () => {
        state.outstandingOperations.set(id, resolve);
        return state;
      };
    }),
    io.chain(state => setClientState(config, state))
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
      resolve(left(getClientErrorFromConnectionError({ timestamp, type: 'Connection has been closed' })))
    )
  );
}

const ioSequenceT = sequenceT(io.io);

function canSendMessage<WS extends typeof WebSocket>(ws: WebSocket, config: ClientConfig<WS>) {
  return (message: string): io.IO<o.Option<string>> =>
    pipe(
      ioSequenceT(getClientState(config), now),
      io.map(
        ([state, time]) =>
          [
            time > o.getOrElse(constant(time))(state.lastMessageReceivedTimestamp) + config.inactivityTimeout,
            ws.readyState === ws.CLOSED
          ] as const
      ),
      io.map(([exceedsTimeout, isClosed]) => {
        return isClosed || exceedsTimeout ? o.none : o.some(message);
      })
    );
}

function attachIdToStartMessage(input: any) {
  return (id: number) => [id, constructMessage(id, GQL_START, input)] as const;
}

function foldMessageIntoIO<WS extends typeof WebSocket, TVariables, TData>(
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
            io.chain(foldMessageIntoIO(config, ws, input, resolve))
          )();
        });
    })
  );
}

function getObservable<TData>(): [ResolveFunction<TData>, Observable<ClientData<TData>>] {
  let listenerId = 0;
  const listeners: Map<number, ResolveFunction<TData>> = new Map();
  const subscribe = (f: ResolveFunction<TData>): io.IO<Unsubscribe> => {
    return () => {
      const id = listenerId++;
      listeners.set(id, f);
      return () => listeners.delete(id);
    };
  };
  const onNext = (value: ClientData<TData>) => listeners.forEach(f => f(value));
  return [onNext, { subscribe }];
}

function subscribe<WS extends typeof WebSocket, TVariables, TData>(
  config: ClientConfig<WS>,
  input: SubscriptionInput<TVariables>
): te.TaskEither<ClientError, Observable<ClientData<TData>>> {
  return pipe(
    getWebSocket(mergeDataProcessorToConfig(config)),
    te.mapLeft(getClientErrorFromConnectionError),
    te.chain<ClientError, WebSocket, Observable<ClientData<TData>>>(ws => {
      const [onNext, observable] = getObservable<TData>();
      return pipe(
        getNextOperationId,
        io.map(attachIdToStartMessage(input)),
        io.chain(foldMessageIntoIO(config, ws, input, onNext)),
        io.apSecond(io.of(observable)),
        te.rightIO
      );
    })
  );
}

export interface GraphqlClient {
  query: <TVariables, TData>(input: QueryInput<TVariables>) => te.TaskEither<ClientError, TData>;
  mutate: <TVariables, TData>(input: MutationInput<TVariables>) => te.TaskEither<ClientError, TData>;
  subscribe: <TVariables, TData>(
    input: SubscriptionInput<TVariables>
  ) => te.TaskEither<ClientError, Observable<ClientData<TData>>>;
}

export function getGraphqlClient<WS extends typeof WebSocket>(config: ClientConfig<WS>): GraphqlClient {
  return {
    query: input => mutateOrQuery(config, input),
    mutate: input => mutateOrQuery(config, input),
    subscribe: input => subscribe(config, input)
  };
}
