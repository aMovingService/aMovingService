import { GoogleAuth } from 'google-auth-library';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
};

const AWS_REGION = process.env.SES_AWS_REGION || 'us-east-2';
export const SES_BUSINESS = 'amovingservice';
const SES_FROM = 'A Moving Service <noreply@amovingservice.com>';
const SES_REPLY_TO = 'contact@amovingservice.com';
let cachedCredentials: AwsCredentials | null = null;
let cachedSesClient: SESv2Client | null = null;

async function googleIdentityToken(audience: string) {
  const client = await new GoogleAuth().getIdTokenClient(audience);
  return client.idTokenProvider.fetchIdToken(audience);
}

async function temporaryAwsCredentials(): Promise<AwsCredentials> {
  if (cachedCredentials && cachedCredentials.expiration.getTime() > Date.now() + 5 * 60_000) return cachedCredentials;
  const roleArn = process.env.SES_ASSUME_ROLE_ARN;
  const audience = process.env.SES_WEB_IDENTITY_AUDIENCE;
  if (!roleArn || !audience) throw new Error('SES_FEDERATION_NOT_CONFIGURED');
  const response = await new STSClient({ region: AWS_REGION }).send(new AssumeRoleWithWebIdentityCommand({
    RoleArn: roleArn,
    RoleSessionName: `ams-email-${Date.now()}`,
    WebIdentityToken: await googleIdentityToken(audience),
    DurationSeconds: 900,
  }), { abortSignal: AbortSignal.timeout(10_000) });
  const credentials = response.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken || !credentials.Expiration) {
    throw new Error('SES_FEDERATION_CREDENTIALS_MISSING');
  }
  cachedCredentials = {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  };
  return cachedCredentials;
}

function sesClient() {
  return cachedSesClient ??= new SESv2Client({ region: AWS_REGION, credentials: temporaryAwsCredentials, maxAttempts: 1 });
}

export async function sendSes(id: string, attemptId: string, recipient: string, pilot: boolean) {
  const configurationSet = process.env.SES_CONFIGURATION_SET;
  if (configurationSet !== 'amovingservice-transactional') throw new Error('SES_CONFIGURATION_SET_MISSING');
  const result = await sesClient().send(new SendEmailCommand({
    FromEmailAddress: SES_FROM,
    Destination: { ToAddresses: [recipient] },
    ReplyToAddresses: [SES_REPLY_TO],
    ConfigurationSetName: configurationSet,
    Content: {
      Simple: {
        Subject: { Data: pilot ? 'TEST — A Moving Service quote alerts' : 'New quote request', Charset: 'UTF-8' },
        Body: { Text: { Data: pilot ? 'This is a delivery test. No customer quote was created.' : 'A customer requested a planning call. Sign in to the staff dashboard at https://amovingservice.com/admin to review it.', Charset: 'UTF-8' } },

      },
    },
    EmailTags: [
      { Name: 'outboxId', Value: id },
      { Name: 'business', Value: SES_BUSINESS },
      { Name: 'attemptId', Value: attemptId },
      ...(pilot ? [{ Name: 'test', Value: 'pilot' }] : []),
    ],
  }), { abortSignal: AbortSignal.timeout(30_000) });
  if (!result.MessageId) throw new Error('SES_MESSAGE_ID_MISSING');
  return { provider: 'ses', providerMessageId: result.MessageId, status: 'accepted' as const };
}

export function safeTransientEmailError(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = value?.$metadata?.httpStatusCode;
  return status === 429 || (status === 400 && value?.name === 'ThrottlingException');
}
