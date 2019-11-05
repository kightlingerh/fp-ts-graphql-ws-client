# (WIP!) fp-ts-graphql-ws-client

A GraphQL WebSocket client to facilitate GraphQL queries, mutations, and subscriptions over WebSocket. Built on top of the fp-ts ecosystem.

# Getting Started

Start by installing the package, using Yarn or NPM.

    Using Yarn:
    $ yarn add fp-ts-graphql-ws-client

    Or, using NPM:
    $ npm install --save fp-ts-graphql-ws-client
    
    > This package depends on `fp-ts` and `retry-policy`
    
 ## Client
 
 ```ts
import { getGraphqlClient } from 'fp-ts-graphql-ws-client/lib/client';

const CLIENT_CONFIG = {
  webSocketConstructor: WebSocket,
  url: 'ws://localhost:4000/graphql'
  inactivityTimeout: 35000 // in milliseconds, should be longer than frequency at which server sends keep alive messages, typically 30ms
  // ... additional parameters for retryPolicy, eventListeners, connectionParams, and protocols beyond 'graphql-ws'
}
 
export const GRAPHQL_CLIENT = getGraphqlClient(CLIENT_CONFIG);
 
 ```
 
 `getGraphqlClient` returns an object with three functions: `mutate`, `query`, and `subscribe`.
 
 `mutate` and `query` return `TaskEither<ClientError, TData>` where TData is the shape of the data expected from the server. `fp-ts-graphql-ws-client` does not provide any type of data validation. See the very awesome https://github.com/gcanti/io-ts, also part of the `fp-ts` ecosystem, if you are interested in runtime type checking.
 
 `subscribe` returns a `TaskEither<ClientError, Observable<TData>>` which provides the ability to subscribe to server sent messages.
