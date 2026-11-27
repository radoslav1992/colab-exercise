/** Names of things kept in this browser's localStorage that more than one script needs to know. */

/**
 * Where the secret of a session is kept (src/api.ts reads and writes it). The landing page only
 * looks whether it is there.
 */
export const SECRET_KEY = 'notebook-lab:session-secret'
