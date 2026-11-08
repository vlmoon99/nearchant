// Sign in with any NEAR wallet (NEP-413). Server: createChallenge + verifySignedMessage. Browser: signIn.
export { createChallenge, verifySignedMessage, memoryNonceStore, nonceIssuedAt, statusFor } from "./server.js";
export type { Challenge, NonceStore, VerifyInput, VerifyOptions, VerifyResult, VerifyCode } from "./server.js";
export { nep413Payload, verifyNep413, verifyWalletSignature, parsePublicKey, decodeSignature, NEP413_TAG } from "./nep413.js";
export type { Nep413Message } from "./nep413.js";
export { accessKeyPermission, RpcUnavailable, DEFAULT_RPC } from "./rpc.js";
export type { Network, FetchLike, RpcOptions } from "./rpc.js";
export { signIn, finishRedirectSignIn, defaultModules } from "./sign-in.js";
export type { SignedLogin, SignInOptions } from "./sign-in.js";
