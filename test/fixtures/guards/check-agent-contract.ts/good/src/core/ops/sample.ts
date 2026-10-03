declare function opError(...args: unknown[]): Error;
export function f() { throw opError('invalid_params', 'Bad input.', 'Pass a slug.', { fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', why: 'w', requires_exclusive: false, verify: { argv: ['gbrain', 'doctor', '--json'] } } }); }
