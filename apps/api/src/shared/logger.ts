type Fields = Record<string, unknown>;

function write(level: 'info' | 'warn' | 'error', msg: string, fields?: Fields) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};
