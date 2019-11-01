import { sequenceT } from 'fp-ts/lib/Apply';
import { now } from 'fp-ts/lib/Date';
import { Either, isRight, left, right } from 'fp-ts/lib/Either';
import { constant, flow, FunctionN, increment } from 'fp-ts/lib/function';
import { IO, chain as chainIO } from 'fp-ts/lib/IO';
import {
  chain,
  fold,
  fromEither,
  fromNullable,
  isNone,
  isSome,
  mapNullable,
  none,
  option,
  Option,
  some,
  toUndefined
} from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/pipeable';
import { rightIO, taskEither, TaskEither, chain as chainTE, mapLeft, map, leftIO } from 'fp-ts/lib/TaskEither';
import { Error } from 'tslint/lib/error';
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

type Unsubscribe = IO<void>;

interface Observable<T> {
  subscribe(onNext: (value: T) => void): IO<Unsubscribe>;
}

interface ClientState {
  nextOperationId: number;
  lastMessageReceivedTimestamp: Option<number>;
  outstandingOperations: Map<number, ResolveFunction<any>>;
}

const CLIENT_STATES: Map<string, ClientState> = new Map();

function constructClientState(): ClientState {
  return {
    nextOperationId: 0,
    lastMessageReceivedTimestamp: none,
    outstandingOperations: new Map()
  };
}

function getClientState<WS extends typeof WebSocket>(config: WebSocketConfig<WS>): IO<ClientState> {
  return () => {
    const state = fromNullable(CLIENT_STATES.get(config.url));
    if (isSome(state)) {
      return state.value;
    } else {
      const newState = constructClientState();
      CLIENT_STATES.set(config.url, newState);
      return newState;
    }
  };
}

function setClientState<WS extends typeof WebSocket>(
  config: WebSocketConfig<WS>,
  newState: ClientState
): IO<ClientState> {
  return () => {
    CLIENT_STATES.set(config.url, newState);
    return newState;
  };
}

function extractIdFromParsedMessage(parsedMessage: ClientData<object>): Option<number> {
  return pipe(
    fromEither<ClientError, { id?: number }>(parsedMessage),
    mapNullable(message => message.id)
  );
}

function extractErrorsFromParsedMessage(parsedMessage: ClientData<object>): Option<GraphQLError[]> {
  return pipe(
    fromEither<ClientError, { payload?: { errors?: GraphQLError[] } }>(parsedMessage),
    mapNullable(message => message.payload),
    mapNullable(payload => payload.errors)
  );
}

function extractDataFromParsedMessage<T>(parsedMessage: ClientData<object>): Option<T> {
  return pipe(
    fromEither<ClientError, { payload?: { data?: T } }>(parsedMessage),
    mapNullable(message => message.payload),
    mapNullable(payload => payload.data)
  );
}

const optionSequenceT = sequenceT(option);

function getDataProcessor<WS extends typeof WebSocket>(config: WebSocketConfig<WS>) {
  return (receivedData: MessageEvent) => {
    const state = fromNullable(CLIENT_STATES.get(config.url));
    const parsedMessage: Either<ClientError, object> = parseReceivedMessage(receivedData.data);
    const id = extractIdFromParsedMessage(parsedMessage);
    const type = toUndefined(extractTypeFromParsedMessage(parsedMessage));
    const operation = pipe(
      optionSequenceT(state, id),
      chain(([st, extractedId]) => fromNullable(st.outstandingOperations.get(extractedId)))
    );
    switch (type) {
      case GQL_COMPLETE:
        pipe(
          optionSequenceT(state, id),
          fold(lazyIOVoid, ([st, extractedId]) => () => st.outstandingOperations.delete(extractedId))
        )();
        break;
      case GQL_DATA:
        if (isRight(parsedMessage) && isSome(operation)) {
          const errors = extractErrorsFromParsedMessage(parsedMessage);
          const data = extractDataFromParsedMessage(parsedMessage);
          const result: Either<ClientError, any> = isSome(errors)
            ? left(getClientError({ graphqlErrors: errors.value }))
            : isNone(data)
            ? left(getClientError({ otherErrors: [new Error('No data received')] }))
            : right(data.value);
          operation.value(result);
        }
        break;
      case GQL_CONNECTION_KEEP_ALIVE:
        pipe(
          state,
          fold(lazyIOVoid, st => () => {
            st.lastMessageReceivedTimestamp = some(now());
          })
        )();
        break;
    }
  };
}

const taskEitherSequenceT = sequenceT(taskEither);

function mergeEventListeners<WS extends typeof WebSocket>(
  config: WebSocketConfig<WS>,
  eventListeners: Partial<WebSocketEventListeners> = {}
): Partial<WebSocketEventListeners> {
  return {
    message: [...(eventListeners && eventListeners.message ? eventListeners.message : []), getDataProcessor(config)]
  };
}

function mergeDataProcessorToConfig<WS extends typeof WebSocket>(config: WebSocketConfig<WS>): WebSocketConfig<WS> {
  return {
    ...config,
    eventListeners: mergeEventListeners(config, config.eventListeners)
  };
}

function getInvalidOperationOptionsError<T>(options: OperationInput<T>) {
  return getClientError({
    otherErrors: [new Error(`Operation input must be JSON-parseable, received ${options}`)]
  });
}

function getClientErrorFromConnectionError(connectionError?: ConnectionError): ClientError {
  return getClientError({
    connectionError: fromNullable(connectionError)
  });
}

function getWebSocketWithClientState<WS extends typeof WebSocket>(config: WebSocketConfig<WS>) {
  return pipe(
    getWebSocket(mergeDataProcessorToConfig(config)),
    mapLeft(getClientErrorFromConnectionError),
    ws => taskEitherSequenceT(ws, rightIO(getClientState(config)))
  );
}

function updateClientState<WS extends typeof WebSocket, TData>(
  config: WebSocketConfig<WS>,
  currentState: ClientState,
  resolve: ResolveFunction<TData>
): IO<void> {
  return setClientState(config, {
    ...currentState,
    nextOperationId: increment(currentState.nextOperationId),
    outstandingOperations: currentState.outstandingOperations.set(currentState.nextOperationId, resolve)
  });
}

function getResolveWithInvalidOptionsIO<TVariables, TData>(
  options: OperationInput<TVariables>,
  resolve: ResolveFunction<TData>
) {
  return () => resolve(left(getInvalidOperationOptionsError(options)));
}

function _mutateOrQuery<WS extends typeof WebSocket, TVariables extends object, TData extends object>(
  config: WebSocketConfig<WS>,
  input: MutationInput<TVariables> | QueryInput<TVariables>
): TaskEither<ClientError, TData> {
  return pipe(
    getWebSocketWithClientState(config),
    chainTE(([ws, state]) => {
      return () =>
        new Promise(resolve => {
          pipe(
            constructMessage(state.nextOperationId, GQL_START, input),
            fold(
              () => getResolveWithInvalidOptionsIO(input, resolve),
              flow(
                sendRawMessage(ws),
                chainIO(() => updateClientState(config, state, resolve))
              )
            )
          )();
        }) as any;
    })
  );
}

export function mutate<WS extends typeof WebSocket>(
  config: WebSocketConfig<WS>
): <TVariables extends object, TData extends object>(
  input: MutationInput<TVariables>
) => TaskEither<ClientError, TData>;
export function mutate<WS extends typeof WebSocket, TVariables extends object, TData extends object>(
  config: WebSocketConfig<WS>,
  input: MutationInput<TVariables>
): TaskEither<ClientError, TData>;
export function mutate<WS extends typeof WebSocket, TVariables extends object, TData extends object>(
  config: WebSocketConfig<WS>,
  input?: MutationInput<TVariables>
): any {
  if (input === undefined) {
    return <TVariables extends object, TData extends object>(input: MutationInput<TVariables>) =>
      _mutateOrQuery(config, input);
  } else {
    return _mutateOrQuery(config, input);
  }
}

export function query<WS extends typeof WebSocket>(
  config: WebSocketConfig<WS>
): <TVariables extends object, TData extends object>(input: QueryInput<TVariables>) => TaskEither<ClientError, TData>;
export function query<WS extends typeof WebSocket, TVariables extends object, TData extends object>(
  config: WebSocketConfig<WS>,
  input: QueryInput<TVariables>
): TaskEither<ClientError, TData>;
export function query<WS extends typeof WebSocket, TVariables extends object, TData extends object>(
  config: WebSocketConfig<WS>,
  input?: QueryInput<TVariables>
): any {
  if (input === undefined) {
    return <TVariables extends object, TData extends object>(input: QueryInput<TVariables>) =>
      _mutateOrQuery(config, input);
  } else {
    return _mutateOrQuery(config, input);
  }
}

function _getObservable<TData>(): [ResolveFunction<TData>, Observable<ClientData<TData>>] {
  let listenerId = 0;
  const listeners: Map<number, ResolveFunction<TData>> = new Map();
  const subscribe = (f: ResolveFunction<TData>): IO<Unsubscribe> => {
    return () => {
      const id = listenerId++;
      listeners.set(id, f);
      return () => listeners.delete(id);
    };
  };
  const onNext = (value: ClientData<TData>) => listeners.forEach(f => f(value));
  return [onNext, { subscribe }];
}

function _subscribe<WS extends typeof WebSocket, TVariables extends object, TData extends object>(
  config: WebSocketConfig<WS>,
  input: SubscriptionInput<TVariables>
): TaskEither<ClientError, Observable<ClientData<TData>>> {
  return pipe(
    getWebSocketWithClientState(config),
    chainTE(([ws, state]) => {
      const [onNext, observable] = _getObservable<TData>();
      return pipe(
        constructMessage(state.nextOperationId, GQL_START, input),
        message =>
          isNone(message)
            ? leftIO<ClientError>(constant(getInvalidOperationOptionsError(input)))
            : rightIO<ClientError, void>(updateClientState(config, state, onNext)),
        map(_ => observable)
      );
    })
  );
}

export function subscribe<WS extends typeof WebSocket>(
  config: WebSocketConfig<WS>
): <TVariables extends object, TData extends object>(
  input: SubscriptionInput<TVariables>
) => TaskEither<ClientError, TData>;
export function subscribe<WS extends typeof WebSocket, TVariables extends object, TData extends object>(
  config: WebSocketConfig<WS>,
  input: SubscriptionInput<TVariables>
): TaskEither<ClientError, TData>;
export function subscribe<WS extends typeof WebSocket, TVariables extends object, TData extends object>(
  config: WebSocketConfig<WS>,
  input?: SubscriptionInput<TVariables>
): any {
  if (input === undefined) {
    return <TVariables extends object, TData extends object>(input: SubscriptionInput<TVariables>) =>
      _subscribe(config, input);
  } else {
    return _subscribe(config, input);
  }
}
