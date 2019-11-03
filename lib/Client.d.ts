import { Either } from 'fp-ts/lib/Either';
import * as io from 'fp-ts/lib/IO';
import * as te from 'fp-ts/lib/TaskEither';
import { ClientError } from './shared';
import { WebSocketConfig } from './WebSocket';
export interface ClientConfig<WS extends typeof WebSocket> extends WebSocketConfig<WS> {
    inactivityTimeout: number;
}
export declare const DEFAULT_INACTIVITY_TIMEOUT = 30000;
export interface MutationInput<TVariables> {
    mutation: string;
    operationName: string;
    variables: TVariables;
}
export interface QueryInput<TVariables> {
    query: string;
    operationName: string;
    variables: TVariables;
}
export interface SubscriptionInput<TVariables> {
    subscription: string;
    operationName: string;
    variables: TVariables;
}
declare type ClientData<T> = Either<ClientError, T>;
declare type Unsubscribe = io.IO<void>;
interface Observable<T> {
    subscribe(onNext: (value: T) => void): io.IO<Unsubscribe>;
}
export interface GraphqlClient {
    query: <TVariables extends object, TData extends object>(input: QueryInput<TVariables>) => te.TaskEither<ClientError, TData>;
    mutate: <TVariables extends object, TData extends object>(input: MutationInput<TVariables>) => te.TaskEither<ClientError, TData>;
    subscribe: <TVariables extends object, TData extends object>(input: SubscriptionInput<TVariables>) => te.TaskEither<ClientError, Observable<ClientData<TData>>>;
}
export declare function getGraphqlClient<WS extends typeof WebSocket>(config: ClientConfig<WS>): GraphqlClient;
export {};
