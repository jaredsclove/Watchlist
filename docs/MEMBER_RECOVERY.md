# Member accounts and recovery (runbook)

Accounts are created by the library owner; there is no public sign-up and no email is involved. Members sign in
with an email and a password, and stay signed in on each device until they sign out. Library access is decided
by the database: a member's rows, and membership in `private.library_members`.

Passwords are always typed by the person they belong to, or by the owner; never written into files, chats, logs
or review material.

## Adding a member

1. Dashboard → Authentication → Users → **Add user → Create new user**: their email, an initial password the
   owner types, **Auto Confirm User** on.
2. SQL Editor: `insert into private.library_members (user_id, note) values ('<their user id>', '<who>');`
3. Give them the initial password privately. They sign in, then change it under Settings → Account → Change
   password.

## A forgotten password

1. Reset it:
   - in the dashboard, if it offers setting the user's password directly; or
   - with `node tools/admin-set-password.mjs --project <ref> --user <user id>`. Before running it, create a
     temporary secret API key in the dashboard; the tool asks for it and for the new password at hidden prompts.
     **Delete that key afterwards.**
2. Give the person the new password privately; they change it at their next sign-in.

## A lost device, or a password that may be known to someone else

The order matters. Membership is restored only once no access token issued before step 3 can still be valid.

1. **Disable membership:**
   `delete from private.library_members where user_id = '<id>';`
   From the next request, the account reads nothing and changes nothing, whatever token is used.
2. **Reset the password** (as above).
3. **End every other session.**
   - On a trusted device, sign in as that account with the new password, then Settings → Account → **Sign out
     other devices**. This is Auth's own mechanism (`signOut` with scope `others`).
   - Note the time it completed.
4. **Check** that the lost device's session no longer works. It should be asked to sign in again once its
   current access ends. Never assume it from missing rows.
5. **Wait** for the project's access-token lifetime plus 5 minutes after step 3. That is 1 hour 5 minutes at the
   default lifetime; the 5 minutes cover the API's clock-skew allowance.
6. **Restore membership:**
   `insert into private.library_members (user_id, note) values ('<id>', '<who>');`
   The person signs in afresh with the new password.

## Removing a member

1. Disable membership (step 1 above) and end their sessions (steps 2–3).
2. If they want their library, export it first (`docs/ADMIN_RESTORE.md`, step 3).
3. Only then delete their rows, and finally their Auth user. Deleting a login never deletes a library: the
   database refuses while rows exist.

## The owner

- The owner is a member like any other and recovers the same way, using the dashboard.
- Losing the Supabase account itself (its sign-in, its MFA) is Supabase account recovery, outside the app. The
  format-5 backups remain the library's safety net.
- Self-service "forgot password" by email is not offered. It would need email delivery (custom SMTP) and could be
  added later without other changes.
