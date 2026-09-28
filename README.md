# @hanzofc/baileys

<div align="center">
  <img alt="Baileys logo" src="https://raw.githubusercontent.com/WhiskeySockets/Baileys/refs/heads/master/Media/logo.png" height="75"/>
</div>

<div align="center">
  A customized fork of Baileys with additional fixes, modifications, and improvements.
</div>

<br />

<div align="center">
  <a href="https://www.npmjs.com/package/@hanzofc/baileys">
    <img src="https://img.shields.io/npm/v/@hanzofc/baileys.svg" alt="npm version" />
  </a>
  <a href="https://github.com/harissfx/Baileys3">
    <img src="https://img.shields.io/github/stars/harissfx/Baileys3.svg" alt="GitHub stars" />
  </a>
  <a href="https://github.com/harissfx/Baileys3">
    <img src="https://img.shields.io/github/license/harissfx/Baileys3.svg" alt="license" />
  </a>
</div>

> [!IMPORTANT]
> This project is a **modified fork of [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)**.
>
> The original Baileys project and its upstream contributors are credited below. This fork is independently maintained and published as `@hanzofc/baileys`.

## About

`@hanzofc/baileys` is a customized fork of **Baileys**, a TypeScript library for interacting with WhatsApp Web through WebSockets.

This fork is maintained separately from the upstream project and contains additional fixes, modifications, and changes used by the author for WhatsApp automation projects.

### Features

* WhatsApp Web socket connection
* Multi-device support
* TypeScript support
* Authentication state management
* Message sending and receiving
* Group management
* Media messages
* Interactive messages (buttons, lists, native flow with the required `biz` nodes)
* Presence updates
* Contact and profile information
* Event-based architecture
* Extra message types: product, order, payment request, event, album, poll result, group status, group member label
* `richMenu` and `sendHtml` helpers
* `useSqliteAuthState` (single-file SQLite auth storage)
* Fine-grained relay options (`isSecret`, `protected`, `me`)
* Additional fixes and modifications maintained in this fork

## Differences from Upstream

This fork is based on [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) `7.0.0-rc14` (compared against upstream commit `0af2386`, "advertise WIN_HYBRID instead of retired WIN32 web sub-platform"). Everything else in the library behaves like upstream.

| Area | Upstream | This fork |
| --- | --- | --- |
| Package name | `baileys` | `@hanzofc/baileys` |
| Version | `7.0.0-rc14` | `7.0.0` |
| Auth state | `useMultiFileAuthState` | Adds `useSqliteAuthState` (needs Node 22.5+) |
| `sendMessage` content | Standard content types | Adds `productMessage`, `orderMessage`, `requestPaymentMessage`, `eventMessage`, `albumMessage`, `pollResultMessage`, `groupStatus`, `groupLabel` |
| Extra socket methods | - | `richMenu(jid, content)`, `sendHtml(jid, html)` |
| Interactive messages | Sent as-is | Adds `biz` / `native_flow` / `bot` nodes automatically for buttons, lists and native flow |
| `relayMessage` options | `participant` (retry resend) | Retry resend renamed to `participants`; `participant` now means "recipient only"; adds `isSecret`, `protected`, `me` |
| Client platform | `WEB`, or `ANDROID` if the browser name contains "android" | Always `MACOS` |
| On connect | Nothing extra | Auto-follows the newsletter JIDs listed in `AUTO_FOLLOW_NEWSLETTER_JIDS` |
| Protobuf | Upstream definitions | Adds `BloksWidget` to `WAProto` |
| Build output | - | ESM imports use explicit `.js` extensions |

> [!WARNING]
> Some of these changes affect behavior or the public API. Read the sections below before upgrading from upstream.

### Requirements

* Node.js 20 or newer (enforced by `engine-requirements.js` on install)
* Node.js 22.5 or newer only if you use `useSqliteAuthState` (it relies on the built-in `node:sqlite` module)

### Breaking / behavior changes

**Retry resend option renamed.** Upstream passes `{ participant: { jid, count } }` to `relayMessage` when re-sending after a failed decryption. In this fork that option is `participants`. `participant: { jid }` (without `count`) now targets only that recipient. If you call `relayMessage` directly with the old shape, update your code.

**Client platform is always `MACOS`.** Upstream chooses `WEB` (or `ANDROID` when `browser[1]` contains "android"). This fork always advertises `MACOS` in the client payload.

**Newsletter auto-follow.** On the first `connection: 'open'`, the socket calls `newsletterFollow` for each JID in `AUTO_FOLLOW_NEWSLETTER_JIDS` (defined in `src/Socket/index.ts`). Errors are ignored. There is currently no config option for this: to disable it, empty that array in the source and rebuild.

## Installation

Install the package directly from npm:

```bash
npm install @hanzofc/baileys
```

Using yarn:

```bash
yarn add @hanzofc/baileys
```

Using pnpm:

```bash
pnpm add @hanzofc/baileys
```

### Existing projects using `baileys`

If your project already imports the package using:

```ts
import makeWASocket from 'baileys'
```

you can install this fork using an npm alias:

```bash
npm install baileys@npm:@hanzofc/baileys
```

This allows existing imports using `baileys` to continue working without changing every import in your project.

## Usage

```ts
import makeWASocket from '@hanzofc/baileys'

const sock = makeWASocket({
    // options
})
```

If you installed the package using the npm alias:

```bash
npm install baileys@npm:@hanzofc/baileys
```

you can continue using:

```ts
import makeWASocket from 'baileys'
```

## Authentication

Baileys uses an authentication state to store the credentials required to reconnect to WhatsApp.

A common setup is to use `useMultiFileAuthState`:

```ts
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState
} from '@hanzofc/baileys'

const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

const sock = makeWASocket({
    auth: state
})

sock.ev.on('creds.update', saveCreds)
```

The authentication files should generally not be committed to Git.

Add your authentication directory to `.gitignore`:

```gitignore
auth_info_baileys/
```

### SQLite auth state

As an alternative to many JSON files, the whole auth state can be stored in a single SQLite database:

```ts
import makeWASocket, { useSqliteAuthState } from '@hanzofc/baileys'

const { state, saveCreds, close } = await useSqliteAuthState('./auth')

const sock = makeWASocket({ auth: state })

sock.ev.on('creds.update', saveCreds)
```

Notes:

* Requires Node.js 22.5+ (built-in `node:sqlite`). On older versions it throws and you should use `useMultiFileAuthState` instead.
* The first argument is either a `.db` / `.sqlite` / `.sqlite3` file path or a folder. For a folder the file is `auth.db` unless you set `fileName`.
* To migrate an existing `useMultiFileAuthState` folder, pass `migrateFromFolder`. It is only used when the database has no credentials yet.
* Call `close()` when you shut the socket down.

```ts
const { state, saveCreds } = await useSqliteAuthState('./auth', {
    fileName: 'auth.db',
    migrateFromFolder: './auth_info_baileys'
})
```

Add the database to `.gitignore` as well:

```gitignore
auth/
```

## Connection Handling

You can listen for connection updates using `connection.update`:

```ts
sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'close') {
        console.log('connection closed')

        const shouldReconnect =
            (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut

        if (shouldReconnect) {
            // reconnect
        }
    }

    if (connection === 'open') {
        console.log('connected')
    }
})
```

## Sending Messages

### Text

```ts
await sock.sendMessage(jid, {
    text: 'Hello World!'
})
```

### Image

```ts
await sock.sendMessage(jid, {
    image: { url: './image.jpg' },
    caption: 'Hello!'
})
```

### Video

```ts
await sock.sendMessage(jid, {
    video: { url: './video.mp4' },
    caption: 'Hello!'
})
```

### Audio

```ts
await sock.sendMessage(jid, {
    audio: { url: './audio.mp3' },
    mimetype: 'audio/mpeg'
})
```

### Document

```ts
await sock.sendMessage(jid, {
    document: { url: './document.pdf' },
    mimetype: 'application/pdf',
    fileName: 'document.pdf'
})
```

### Sticker

```ts
await sock.sendMessage(jid, {
    sticker: { url: './sticker.webp' }
})
```

## Replying to Messages

Messages can be quoted when sending a response:

```ts
await sock.sendMessage(
    jid,
    {
        text: 'This is a reply'
    },
    {
        quoted: message
    }
)
```

## Message Events

Incoming messages can be handled through `messages.upsert`:

```ts
sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const message of messages) {
        console.log(message)
    }
})
```

For example:

```ts
sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]

    if (!msg.message) return

    console.log(msg.message)
})
```

## Groups

### Get Group Metadata

```ts
const metadata = await sock.groupMetadata(jid)

console.log(metadata)
```

### Create a Group

```ts
const group = await sock.groupCreate('My Group', [
    '1234567890@s.whatsapp.net'
])
```

### Add Participants

```ts
await sock.groupParticipantsUpdate(
    jid,
    ['1234567890@s.whatsapp.net'],
    'add'
)
```

### Remove Participants

```ts
await sock.groupParticipantsUpdate(
    jid,
    ['1234567890@s.whatsapp.net'],
    'remove'
)
```

### Promote Participants

```ts
await sock.groupParticipantsUpdate(
    jid,
    ['1234567890@s.whatsapp.net'],
    'promote'
)
```

### Demote Participants

```ts
await sock.groupParticipantsUpdate(
    jid,
    ['1234567890@s.whatsapp.net'],
    'demote'
)
```

## Presence

Presence can be updated using:

```ts
await sock.sendPresenceUpdate('available', jid)
```

Available presence values include:

```text
available
unavailable
composing
recording
paused
```

For example:

```ts
await sock.sendPresenceUpdate('composing', jid)

await new Promise(resolve => setTimeout(resolve, 2000))

await sock.sendPresenceUpdate('paused', jid)
```

## Contacts

You can request information about a WhatsApp user:

```ts
const result = await sock.onWhatsApp('1234567890')
console.log(result)
```

## Profile Picture

```ts
const profilePicture = await sock.profilePictureUrl(
    jid,
    'image'
)

console.log(profilePicture)
```

Depending on the account and privacy settings, the profile picture may not be available.

## Presence Updates

You can subscribe to presence updates:

```ts
sock.ev.on('presence.update', (update) => {
    console.log(update)
})
```

## Typing Indicators

To indicate that the bot is typing:

```ts
await sock.sendPresenceUpdate('composing', jid)
```

Stop typing:

```ts
await sock.sendPresenceUpdate('paused', jid)
```

## Read Receipts

Messages can be marked as read:

```ts
await sock.readMessages([
    message.key
])
```

## Reactions

Send a reaction to a message:

```ts
await sock.sendMessage(
    jid,
    {
        react: {
            text: '👍',
            key: message.key
        }
    }
)
```

Remove a reaction:

```ts
await sock.sendMessage(
    jid,
    {
        react: {
            text: '',
            key: message.key
        }
    }
)
```

## Deleting Messages

For messages that can be deleted:

```ts
await sock.sendMessage(
    jid,
    {
        delete: message.key
    }
)
```

## Editing Messages

Depending on the message type and supported WhatsApp functionality:

```ts
await sock.sendMessage(
    jid,
    {
        text: 'Edited message',
        edit: message.key
    }
)
```

## Forwarding Messages

Messages can be forwarded using the appropriate message structure:

```ts
await sock.sendMessage(
    jid,
    {
        forward: message
    }
)
```

The exact structure may vary depending on the message type and Baileys version.

## Media

Baileys supports sending different types of media, including:

* Images
* Videos
* Audio
* Documents
* Stickers

Example:

```ts
await sock.sendMessage(jid, {
    image: {
        url: './image.jpg'
    },
    caption: 'Example image'
})
```

For remote media:

```ts
await sock.sendMessage(jid, {
    image: {
        url: 'https://example.com/image.jpg'
    }
})
```

## Downloading Media

Media can be downloaded from received messages using the media download utilities provided by the library.

Example:

```ts
import {
    downloadMediaMessage
} from '@hanzofc/baileys'

const buffer = await downloadMediaMessage(
    message,
    'buffer',
    {}
)
```

The exact download options depend on the message type and library version.

## Interactive Messages

Buttons, list messages and native flow messages are sent through `sendMessage` as usual. This fork adds the `biz` (and, for private chats, `bot`) binary nodes needed for them to render, so you do not need to pass `additionalNodes` yourself.

Support for particular interactive formats can change as WhatsApp updates its protocol. Check the exported types for the currently supported structures.

### Rich menu

`richMenu` sends quick-reply buttons or a carousel of cards, with an optional image header and an open-URL footer:

```ts
await sock.richMenu(jid, {
    header: { title: 'Menu', image: { url: 'https://example.com/banner.png' } },
    body: { title: 'Choose one', buttons: ['Option 1', 'Option 2'] },
    footer: { text: 'Open website', url: 'https://example.com' }
})
```

Carousel / row of cards:

```ts
await sock.richMenu(jid, {
    body: {
        carousel: true, // or row: true
        cards: [
            { title: 'Card 1', buttons: ['Select'] },
            { title: 'Card 2', buttons: ['Select'] }
        ]
    }
})
```

### HTML

```ts
await sock.sendHtml(jid, '<h1>Hello</h1>')
```

> [!NOTE]
> `richMenu` and `sendHtml` rely on WhatsApp client behavior that is not officially documented, so they may stop working or render differently after a WhatsApp update.

## Special Messages

These content types are handled by `sendMessage` in this fork and are not available in upstream. They are detected automatically from the content object.

### Product

```ts
await sock.sendMessage(jid, {
    productMessage: {
        title: 'Product name',
        description: 'Description',
        thumbnail: { url: './product.jpg' },
        productId: '123',
        retailerId: 'shop',
        url: 'https://example.com',
        body: 'Body text',
        footer: 'Footer text',
        priceAmount1000: 25000000,
        currencyCode: 'IDR',
        buttons: []
    }
})
```

### Order

```ts
await sock.sendMessage(jid, {
    orderMessage: {
        orderTitle: 'Order #1',
        message: 'Thanks for your order',
        totalAmount1000: 50000000,
        totalCurrencyCode: 'IDR',
        itemCount: 2,
        thumbnail: { url: './order.jpg' }
    }
})
```

### Payment request

```ts
await sock.sendMessage(jid, {
    requestPaymentMessage: {
        amount: 10000000, // amount x 1000
        currency: 'IDR',  // default: IDR
        from: '1234567890@s.whatsapp.net',
        note: 'Payment note'
    }
})
```

### Event

```ts
await sock.sendMessage(jid, {
    eventMessage: {
        name: 'Meetup',
        description: 'Monthly meetup',
        startTime: 1790000000,
        endTime: 1790003600,
        location: { degreesLatitude: -7.25, degreesLongitude: 112.75, name: 'Surabaya' }
    }
})
```

### Album

```ts
await sock.sendMessage(jid, {
    albumMessage: [
        { image: { url: './1.jpg' }, caption: 'First' },
        { image: { url: './2.jpg' } },
        { video: { url: './3.mp4' } }
    ]
})
```

### Poll result

```ts
await sock.sendMessage(jid, {
    pollResultMessage: {
        name: 'Favorite color?',
        options: [
            { optionName: 'Red', optionVoteCount: 10 },
            { optionName: 'Blue', optionVoteCount: 7 }
        ]
    }
})
```

### Group status and group member label

```ts
// post a status inside a group
await sock.sendMessage(groupJid, {
    groupStatus: { image: { url: './status.jpg' }, caption: 'Hello group' }
})

// set your member label in a group (max. 30 characters)
await sock.sendMessage(groupJid, {
    groupLabel: 'Admin'
})
```

`groupLabel` only works with group JIDs (`@g.us`).

> [!NOTE]
> These payloads are constructed by hand from observed WhatsApp behavior. Field names beyond the ones shown here can be found in `src/Types/Message.ts` and `src/Socket/special-messages.ts`.

## Relay Options

`relayMessage` accepts extra options that control which devices receive the message:

| Option | Effect |
| --- | --- |
| `participant: { jid }` | Send only to the target's own devices, skipping your own |
| `participants: { jid, count }` | Retry resend to a single participant (used after a decryption failure) |
| `isSecret: true` | Send only to the target's primary device |
| `protected: true` | Send to everything except the target's linked (secondary) devices |
| `me: true` | Send only to your own devices |

`isSecret`, `protected`, `me` and `participant` add `device_fanout: 'false'` to the stanza and have no effect in groups or status broadcasts.

```ts
await sock.relayMessage(jid, message, {
    messageId,
    isSecret: true
})
```

## Events

Baileys uses an event-based architecture.

Common events include:

```text
connection.update
creds.update
messages.upsert
messages.update
messages.delete
messages.reaction
chats.upsert
chats.update
chats.delete
contacts.upsert
contacts.update
presence.update
groups.upsert
groups.update
group-participants.update
```

Example:

```ts
sock.ev.on('messages.upsert', ({ messages }) => {
    console.log(messages)
})
```

## Event Buffering

For applications that perform several operations at once, Baileys provides an event buffer mechanism through its event system.

This can help prevent unnecessary processing when multiple related events are received in a short period of time.

Refer to the exported event types and implementation in this repository for the currently supported behavior.

## TypeScript

This package is written in TypeScript.

Example:

```ts
import makeWASocket, {
    WASocket,
    proto
} from '@hanzofc/baileys'

const sock: WASocket = makeWASocket({})
```

Message structures are available through the exported types:

```ts
import { proto } from '@hanzofc/baileys'

const message: proto.IWebMessageInfo = {}
```

The available types may change between releases.

## Configuration

A socket can be configured using the options exported by the package.

Example:

```ts
const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
})
```

For the complete list of currently supported options, refer to the TypeScript definitions and source code in this repository.

## Logging

Baileys uses `pino` for logging.

Example:

```ts
import pino from 'pino'

const logger = pino({
    level: 'silent'
})

const sock = makeWASocket({
    logger
})
```

For development:

```ts
const logger = pino({
    level: 'debug'
})
```

## Proxy

Proxy configuration depends on the connection implementation and supported socket options.

If you need proxy support, configure the socket using the appropriate agent or connection options supported by the current release.

## QR Code

Depending on the authentication setup and application, you may need to display a QR code when connecting a new account.

The exact QR handling depends on the version and authentication configuration being used.

Example:

```ts
sock.ev.on('connection.update', ({ qr }) => {
    if (qr) {
        console.log('QR:', qr)
    }
})
```

You can use a QR-code library to display the QR in a terminal or application.

## Pairing Code

Where supported, pairing code authentication can be used instead of scanning a QR code.

Example:

```ts
const phoneNumber = '1234567890'

const code = await sock.requestPairingCode(phoneNumber)

console.log(code)
```

The phone number should be provided in international format without `+`, spaces, or other formatting characters.

Example:

```text
6281234567890
```

Availability and behavior of pairing codes may change with WhatsApp and Baileys updates.

## Multi-Device

Baileys supports WhatsApp's multi-device architecture.

Authentication credentials are stored locally so the application can reconnect without repeatedly pairing the account.

Always protect your authentication credentials.

Do not publish or share:

```text
creds.json
session files
authentication keys
app-state keys
```

## Security

Treat your WhatsApp authentication files as sensitive credentials.

Do not:

* Upload authentication files to GitHub.
* Share authentication files with other people.
* Put authentication files inside a public web directory.
* Include authentication credentials in logs.
* Commit `.env` files containing secrets.

A typical `.gitignore` can include:

```gitignore
auth_info_baileys/
.env
node_modules/
```

## WhatsApp Compatibility

Baileys communicates with WhatsApp through the WhatsApp Web protocol.

WhatsApp can change its protocol, message structures, authentication mechanisms, or other behavior at any time.

Because of this, compatibility may change without notice.

If something stops working after a WhatsApp-side change, a new release or code modification may be required.

## Versioning

This fork follows its own npm release versions while remaining based on the upstream Baileys codebase.

The current source is based on upstream `7.0.0-rc14`. The fork's own version (`7.0.0`) does not match upstream's version numbers, so a higher number here does not mean it contains newer upstream changes. The `CHANGELOG.md` file still contains only the upstream `7.0.0-rc14` heading.

Current package:

```text
@hanzofc/baileys
```

Example:

```bash
npm install @hanzofc/baileys@7.0.0
```

For projects using the `baileys` alias:

```bash
npm install baileys@npm:@hanzofc/baileys@7.0.0
```

### Release model

Source changes are maintained on GitHub:

```text
https://github.com/harissfx/Baileys3
```

Published releases are available on npm:

```text
https://www.npmjs.com/package/@hanzofc/baileys
```

GitHub commits do not automatically change an already published npm version.

## Development

Clone the repository:

```bash
git clone https://github.com/harissfx/Baileys3.git
```

Enter the directory:

```bash
cd Baileys3
```

Install dependencies:

```bash
npm install
```

Build the project:

```bash
npm run build
```

The available scripts can be checked with:

```bash
npm run
```

## Using the Local Repository

If you are developing against the local source instead of the published npm package, you can use a local dependency:

```json
{
    "dependencies": {
        "baileys": "file:./Baileys3"
    }
}
```

This is useful when testing changes before publishing a new npm version.

For normal production use, installing the published package is recommended:

```bash
npm install @hanzofc/baileys
```

## Contributing

Issues, bug reports, and pull requests are welcome.

Before opening an issue, please check whether the problem is caused by:

* WhatsApp-side changes
* An authentication/session problem
* A dependency problem
* A configuration issue
* A bug specific to this fork

When reporting a bug, include:

* Node.js version
* Package version
* Operating system
* Relevant error message
* Minimal reproduction when possible

Do not include authentication credentials or private WhatsApp session files.

## Upstream

This project is based on **Baileys**, originally developed and maintained by contributors in the upstream project.

Upstream repository:

https://github.com/WhiskeySockets/Baileys

Upstream documentation:

https://baileys.wiki

This fork does not claim to be the official Baileys repository.

For upstream-specific issues, documentation, or changes, refer to the upstream project.

## Credits

Special thanks to the contributors and maintainers of the original Baileys project.

This fork would not exist without the work of the upstream Baileys community.

Original project:

https://github.com/WhiskeySockets/Baileys

Parts of the additional functionality in this fork were ported from other Baileys forks:

* `wbails` (Baileys2 / `@qwerty-xcv/baileys`): special message types
* `@poucode/baileys`: `biz` / `native_flow` nodes for interactive and product messages
* `@vansnowi/baileys`: `richMenu`, `sendHtml`, `useSqliteAuthState`

## Disclaimer

This project is an independent fork and is not affiliated with, endorsed by, or officially supported by WhatsApp.

WhatsApp is a trademark of Meta Platforms, Inc.

Use this library responsibly and comply with applicable laws, regulations, and WhatsApp's terms and policies.

The maintainers of this fork are not responsible for account restrictions, bans, data loss, or other consequences resulting from the use of this software.

## Documentation

For detailed API information, examples, and exported types, refer to:

* This repository
* The source code
* TypeScript definitions
* Upstream Baileys documentation where applicable

Upstream documentation:

https://baileys.wiki

## License

This project retains the licensing terms of the upstream Baileys project.

See the repository's `LICENSE` file for the complete license text.

Copyright and attribution notices from the original project must be preserved where required.

---

<div align="center">

**@hanzofc/baileys**

A customized fork of Baileys.

GitHub: https://github.com/harissfx/Baileys3

npm: https://www.npmjs.com/package/@hanzofc/baileys

</div>