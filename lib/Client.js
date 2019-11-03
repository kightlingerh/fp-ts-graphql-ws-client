import { sequenceT } from 'fp-ts/lib/Apply';
import { now } from 'fp-ts/lib/Date';
import { isRight, left, right } from 'fp-ts/lib/Either';
import { constant, flow, increment } from 'fp-ts/lib/function';
import * as io from 'fp-ts/lib/IO';
import * as o from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/pipeable';
import * as te from 'fp-ts/lib/TaskEither';
import { Error } from 'tslint/lib/error';
import { GQL_COMPLETE, GQL_CONNECTION_KEEP_ALIVE, GQL_DATA, GQL_START } from './GQLMessage';
import { constructMessage, extractTypeFromParsedMessage, getClientError, lazyIOVoid, parseReceivedMessage, sendRawMessage } from './shared';
import { getWebSocket } from './WebSocket';
export const DEFAULT_INACTIVITY_TIMEOUT = 30000;
const CLIENT_STATES = new Map();
function constructClientState() {
    return {
        nextOperationId: 0,
        lastMessageReceivedTimestamp: o.none,
        outstandingOperations: new Map()
    };
}
function getClientState(config) {
    return () => {
        const state = o.fromNullable(CLIENT_STATES.get(config.url));
        if (o.isSome(state)) {
            return state.value;
        }
        else {
            const newState = constructClientState();
            CLIENT_STATES.set(config.url, newState);
            return newState;
        }
    };
}
function setClientState(config, newState) {
    return () => {
        CLIENT_STATES.set(config.url, newState);
        return newState;
    };
}
function extractIdFromParsedMessage(parsedMessage) {
    return pipe(o.fromEither(parsedMessage), o.mapNullable(message => message.id));
}
function extractErrorsFromParsedMessage(parsedMessage) {
    return pipe(o.fromEither(parsedMessage), o.mapNullable(message => message.payload), o.mapNullable(payload => payload.errors));
}
function extractDataFromParsedMessage(parsedMessage) {
    return pipe(o.fromEither(parsedMessage), o.mapNullable(message => message.payload), o.mapNullable(payload => payload.data));
}
const optionSequenceT = sequenceT(o.option);
function getDataProcessor(config) {
    return (receivedData) => {
        const state = o.fromNullable(CLIENT_STATES.get(config.url));
        const parsedMessage = parseReceivedMessage(receivedData.data);
        const id = extractIdFromParsedMessage(parsedMessage);
        const type = o.toUndefined(extractTypeFromParsedMessage(parsedMessage));
        const operation = pipe(optionSequenceT(state, id), o.chain(([st, extractedId]) => o.fromNullable(st.outstandingOperations.get(extractedId))));
        switch (type) {
            case GQL_COMPLETE:
                pipe(optionSequenceT(state, id), o.fold(lazyIOVoid, ([st, extractedId]) => () => st.outstandingOperations.delete(extractedId)))();
                break;
            case GQL_DATA:
                if (isRight(parsedMessage) && o.isSome(operation)) {
                    const errors = extractErrorsFromParsedMessage(parsedMessage);
                    const data = extractDataFromParsedMessage(parsedMessage);
                    const result = o.isSome(errors)
                        ? left(getClientError({ graphqlErrors: errors.value }))
                        : o.isNone(data)
                            ? left(getClientError({ otherErrors: [new Error('No data received')] }))
                            : right(data.value);
                    operation.value(result);
                }
                break;
            case GQL_CONNECTION_KEEP_ALIVE:
                pipe(state, o.fold(lazyIOVoid, st => () => {
                    st.lastMessageReceivedTimestamp = o.some(now());
                }))();
                break;
        }
    };
}
const taskEitherSequenceT = sequenceT(te.taskEither);
function mergeEventListeners(config, eventListeners = {}) {
    return {
        message: [...(eventListeners && eventListeners.message ? eventListeners.message : []), getDataProcessor(config)]
    };
}
function mergeDataProcessorToConfig(config) {
    return {
        ...config,
        eventListeners: mergeEventListeners(config, config.eventListeners)
    };
}
function getInvalidOperationInputError(input) {
    return getClientError({
        otherErrors: [new Error(`Operation input must be JSON-parseable, received ${input}`)]
    });
}
function getClientErrorFromConnectionError(connectionError) {
    return getClientError({
        connectionError: o.fromNullable(connectionError)
    });
}
function getWebSocketWithClientState(config) {
    return pipe(getWebSocket(mergeDataProcessorToConfig(config)), te.mapLeft(getClientErrorFromConnectionError), ws => taskEitherSequenceT(ws, te.rightIO(getClientState(config))));
}
function updateClientState(config, currentState, resolve) {
    return setClientState(config, {
        ...currentState,
        nextOperationId: increment(currentState.nextOperationId),
        outstandingOperations: currentState.outstandingOperations.set(currentState.nextOperationId, resolve)
    });
}
function getResolveWithInvalidInputIO(input, resolve) {
    return () => resolve(left(getInvalidOperationInputError(input)));
}
function getResolveWithClosedConnectionIO(resolve) {
    return pipe(now, io.map(timestamp => resolve(left(getClientErrorFromConnectionError({ timestamp, type: 'Connection has been closed' })))));
}
function canSendMessage(ws, connectionTimeout, lastTimeout) {
    return (message) => pipe(now, io.map(time => [time > o.getOrElse(constant(time))(lastTimeout) + connectionTimeout, ws.readyState === ws.CLOSED]), io.map(([exceedsTimeout, isClosed]) => {
        return isClosed || exceedsTimeout ? o.none : o.some(message);
    }));
}
function _mutateOrQuery(config, input) {
    return pipe(getWebSocketWithClientState(config), te.chain(([ws, state]) => {
        return () => new Promise(resolve => {
            pipe(constructMessage(state.nextOperationId, GQL_START, input), o.fold(constant(getResolveWithInvalidInputIO(input, resolve)), flow(canSendMessage(ws, config.inactivityTimeout, state.lastMessageReceivedTimestamp), io.chain(o.fold(constant(getResolveWithClosedConnectionIO(resolve)), flow(sendRawMessage(ws), io.apSecond(updateClientState(config, state, resolve))))))))();
        });
    }));
}
function _getObservable() {
    let listenerId = 0;
    const listeners = new Map();
    const subscribe = (f) => {
        return () => {
            const id = listenerId++;
            listeners.set(id, f);
            return () => listeners.delete(id);
        };
    };
    const onNext = (value) => listeners.forEach(f => f(value));
    return [onNext, { subscribe }];
}
function _subscribe(config, input) {
    return pipe(getWebSocketWithClientState(config), te.chain(([ws, state]) => {
        const [onNext, observable] = _getObservable();
        return pipe(constructMessage(state.nextOperationId, GQL_START, input), o.fold(constant(te.leftIO(constant(getInvalidOperationInputError(input)))), flow(canSendMessage(ws, config.inactivityTimeout, state.lastMessageReceivedTimestamp), te.rightIO, te.chain(o.fold(constant(te.leftIO(constant(getInvalidOperationInputError(input)))), flow(sendRawMessage(ws), io.apSecond(updateClientState(config, state, onNext)), io.apSecond(io.of(observable)), te.rightIO))))));
    }));
}
export function getGraphqlClient(config) {
    return {
        query: input => _mutateOrQuery(config, input),
        mutate: input => _mutateOrQuery(config, input),
        subscribe: input => _subscribe(config, input)
    };
}
