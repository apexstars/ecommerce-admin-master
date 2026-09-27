import { logger } from './logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Swap for SES/Postmark/etc. in production; dev just logs. */
export const mailer = {
  async send(mail: Mail) {
    logger.info('mail.sent', { to: mail.to, subject: mail.subject, text: mail.text });
  },
};
