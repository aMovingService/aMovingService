declare module 'sns-validator' {
  type SnsMessage = Record<string, unknown>;
  export default class MessageValidator {
    encoding: string;
    validate(message: SnsMessage, callback: (error: Error | null, message?: SnsMessage) => void): void;
  }
}
