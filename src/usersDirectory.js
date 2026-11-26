// ---------------------------------------------------------------
// The only file that talks to Cognito: the list of accounts for the admin page.
// It returns account details only (id, email, status, admin or not), never goals:
// the admin role manages accounts, it does not read anyone's data.
// ---------------------------------------------------------------
const {
    CognitoIdentityProviderClient, ListUsersCommand, ListUsersInGroupCommand
} = require('@aws-sdk/client-cognito-identity-provider');
const { DependencyError } = require('./internalClients');

const MAX_USERS = 500;      // a coursework-sized pool: stop paging after this many

function attr(user, name) {
    return (user.Attributes || []).find((a) => a.Name === name)?.Value || '';
}

function createUsersDirectory({
    client = new CognitoIdentityProviderClient({}),
    userPoolId = process.env.COGNITO_USER_POOL_ID
} = {}) {
    if (!userPoolId) throw new Error('COGNITO_USER_POOL_ID must be set for the admin API.');

    // Cognito pages its answers (60 at most per page): follow the tokens
    async function all(makeCommand, key) {
        const out = [];
        let token;
        do {
            const page = await client.send(makeCommand(token));
            out.push(...(page[key] || []));
            token = page.PaginationToken || page.NextToken;
        } while (token && out.length < MAX_USERS);
        return out;
    }

    return {
        async listUsers() {
            try {
                const [users, admins] = await Promise.all([
                    all((t) => new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60, PaginationToken: t }), 'Users'),
                    all((t) => new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: 'admin', Limit: 60, NextToken: t }), 'Users')
                ]);
                const adminNames = new Set(admins.map((u) => u.Username));
                return users.map((u) => ({
                    userId: attr(u, 'sub') || u.Username,
                    email: attr(u, 'email') || u.Username,
                    status: u.UserStatus,
                    enabled: u.Enabled !== false,
                    admin: adminNames.has(u.Username),
                    createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : null
                })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
            } catch (error) {
                throw new DependencyError(`Cognito could not be reached (${error.name}).`);
            }
        }
    };
}

module.exports = { createUsersDirectory };
