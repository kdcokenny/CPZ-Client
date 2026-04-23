import { Client, register } from "discord-rpc";
import { BrowserWindow, dialog } from "electron";
import { GAME_NAME, DISCORD_RPC_CLIENT_APP_ID, LARGE_IMAGE_KEY } from "./discord/constants";
import { startRequestListener } from "./discord/requestHandler";
import { Store } from "./store";
import { showReloadDialog } from './reload';
import { CPLocation, CPLocationType, DiscordState } from "./store/DiscordState";
import { stringInject } from './stringinject';

let discordStopPromise: Promise<void> | null = null;

const getDiscordRPCEnabledFromStore = (store: Store) => {
    return store.public.get('enableDiscordRPC');
};

const getDiscordRPCTrackingEnabledFromStore = (store: Store) => {
    return store.public.get('enableDiscordRPCTracker');
};

const updateDiscordRPCEnabledInStore = (store: Store) => {
    store.public.set('enableDiscordRPC', !getDiscordRPCEnabledFromStore(store));
};

const updateDiscordRPCTrackingEnabledInStore = (store: Store) => {
    store.public.set('enableDiscordRPCTracker', !getDiscordRPCTrackingEnabledFromStore(store));
};

export const getDiscordStateFromStore = (store: Store) => {
    return store.private.get('discordState') ?? {};
};

export const setDiscordStateInStore = (store: Store, state: DiscordState) => {
    store.private.set('discordState', state);
};

export const setLocationsInStore = (store: Store, locations: CPLocation[]) => {
    const state = getDiscordStateFromStore(store);

    state.trackedLocations = locations;

    setDiscordStateInStore(store, state);
};

const setUnloggedStatus = (store: Store) => {
    const state = getDiscordStateFromStore(store);

    if (!state || !state.client) {
        return;
    }

    return state.client.setActivity({
        details: state.gameName,
        state: store.private.get('localizer').__('LOC_STATUS_NOT_LOGGED'),
        startTimestamp: state.startTimestamp,
        largeImageKey: LARGE_IMAGE_KEY,
    });
};

const setWaddlingStatus = (store: Store) => {
    const state = getDiscordStateFromStore(store);

    if (!state || !state.client) {
        return;
    }

    return state.client.setActivity({
        details: state.gameName,
        state: store.private.get('localizer').__('LOC_STATUS_WADDLING'),
        startTimestamp: state.startTimestamp,
        largeImageKey: LARGE_IMAGE_KEY,
    });
};

export const setLocationStatusWithMatch = (store: Store, state: DiscordState, match: string) => {
    const result = match.replace(/([A-Z])/g, " $1");
    const finalResult = result.charAt(0).toUpperCase() + result.slice(1);

    if (!state || !state.client) {
        return;
    }

    return state.client.setActivity({
        details: state.gameName,
        state: `${store.private.get('localizer').__('LOC_STATUS_WADDLING_AT')} ${finalResult}`,
        startTimestamp: state.startTimestamp,
        largeImageKey: LARGE_IMAGE_KEY,
    });
};

export const setLocationStatus = (store: Store, state: DiscordState, location: CPLocation) => {
    let msgPrefix: string;
    const localizer = store.private.get('localizer');

    if (location.match.toLowerCase().includes('sensei')) {
        msgPrefix = localizer.__('LOC_STATUS_TALK');
    } else if (location.room_type === CPLocationType.Game) {
        msgPrefix = localizer.__('LOC_STATUS_PLAYING');
    } else if (location.match.toLowerCase().includes('igloo')) {
        msgPrefix = localizer.__('LOC_STATUS_VISITING');
    } else {
        msgPrefix = localizer.__('LOC_STATUS_WADDLING_AT');
    }

    const locationMsg = msgPrefix + ' ' + location.name;

    if (!state || !state.client) {
        return;
    }

    return state.client.setActivity({
        details: state.gameName,
        state: locationMsg,
        startTimestamp: state.startTimestamp,
        largeImageKey: LARGE_IMAGE_KEY,
    });
};

const registerWindowReload = (store: Store, mainWindow: BrowserWindow) => {
    const tempState = getDiscordStateFromStore(store);

    if (tempState.windowReloadRegistered) {
        return;
    }

    tempState.windowReloadRegistered = true;

    setDiscordStateInStore(store, tempState);

    mainWindow.webContents.on('did-start-loading', async () => {
        if (!getDiscordRPCEnabledFromStore(store)) {
            return;
        }

        const state = getDiscordStateFromStore(store);

        // In case URL changed
        state.gameName = GAME_NAME;

        await setUnloggedStatus(store);

        setDiscordStateInStore(store, state);
    });
};

export const startDiscordRPC = (store: Store, mainWindow: BrowserWindow) => {
    if (!getDiscordRPCEnabledFromStore(store) || DISCORD_RPC_CLIENT_APP_ID === '0') {
        if (DISCORD_RPC_CLIENT_APP_ID === '0') {
            // This is mostly for debugging so we can test outside the Discord environment
            registerWindowReload(store, mainWindow);
            startRequestListener(store, mainWindow);
        }
        return;
    }

    const gameName = GAME_NAME;
    const startTimestamp = new Date();

    register(DISCORD_RPC_CLIENT_APP_ID);

    const client = new Client({
        transport: 'ipc',
    });

    setDiscordStateInStore(store, {
        client: client,
        gameName: gameName,
        startTimestamp: startTimestamp,
        windowReloadRegistered: false,
    });

    const rpcTrackingEnabled = getDiscordRPCTrackingEnabledFromStore(store);
    const localizer = store.private.get('localizer');

    client.on('ready', () => {
        client.setActivity({
            details: gameName,
            state: rpcTrackingEnabled ? localizer.__('LOC_STATUS_NOT_LOGGED') : localizer.__('LOC_STATUS_WADDLING'),
            startTimestamp: startTimestamp,
            largeImageKey: LARGE_IMAGE_KEY,
        });
    });

    client.login({
        clientId: DISCORD_RPC_CLIENT_APP_ID
    }).catch(console.error);

    if (!rpcTrackingEnabled) {
        return;
    }

    registerWindowReload(store, mainWindow);
    startRequestListener(store, mainWindow);
};

const isAlreadyDestroyedDiscordClientError = (error: unknown) => {
    if (!(error instanceof Error)) {
        return false;
    }

    const message = error.message.toLowerCase();

    return message.includes('already destroyed')
        || message.includes('not connected')
        || message.includes('connection is closed')
        || message.includes('connection closed')
        || message.includes('disconnected');
};

export const stopDiscordRPC = async (store: Store) => {
    if (discordStopPromise) {
        return discordStopPromise;
    }

    const state = getDiscordStateFromStore(store);
    const discordClient = state?.client;

    if (!discordClient) {
        return;
    }

    discordStopPromise = (async () => {
        try {
            await discordClient.destroy();
        } catch (error) {
            if (!isAlreadyDestroyedDiscordClientError(error)) {
                throw error;
            }
        } finally {
            const latestState = getDiscordStateFromStore(store);

            if (latestState?.client === discordClient) {
                setDiscordStateInStore(store, {});
            }
        }
    })();

    try {
        await discordStopPromise;
    } finally {
        discordStopPromise = null;
    }
};

export const enableOrDisableDiscordRPC = async (store: Store, mainWindow: BrowserWindow) => {
    const localizer = store.private.get('localizer');
    const rpcNotEnabled = !getDiscordRPCEnabledFromStore(store);

    if (rpcNotEnabled) {
        const confirmationEnableResult = await dialog.showMessageBox(mainWindow, {
            buttons: localizer.__buttons(),
            title: stringInject(localizer.__('PROMPT_RICH_PRESENCE_TITLE'), [localizer.__toggle(rpcNotEnabled)]),
            message: stringInject(localizer.__('PROMPT_RICH_PRESENCE_MSG'), [localizer.__toggle(rpcNotEnabled, true)]),
        });

        if (confirmationEnableResult.response !== 0) {
            return;
        }
    }

    updateDiscordRPCEnabledInStore(store);

    if (getDiscordRPCEnabledFromStore(store)) {
        startDiscordRPC(store, mainWindow);
        
        if (getDiscordRPCTrackingEnabledFromStore(store)) {
            showReloadDialog(store, mainWindow);
        }
    } else {
        await stopDiscordRPC(store);
    }
};

export const enableOrDisableDiscordRPCLocationTracking = async (store: Store, mainWindow: BrowserWindow) => {
    const localizer = store.private.get('localizer');
    const rpcTrackingNotEnabled = !getDiscordRPCTrackingEnabledFromStore(store);

    if (rpcTrackingNotEnabled) {
        const confirmationTrackingEnableResult = await dialog.showMessageBox(mainWindow, {
            buttons: localizer.__buttons(),
            title: stringInject(localizer.__('PROMPT_RICH_PRESENCE_ROOM_TITLE'), [localizer.__toggle(rpcTrackingNotEnabled)]),
            message: localizer.__('PROMPT_RICH_PRESENCE_ROOM_MSG'),
        });

        if (confirmationTrackingEnableResult.response !== 0) {
            return;
        }
    }

    updateDiscordRPCTrackingEnabledInStore(store);

    if (getDiscordRPCTrackingEnabledFromStore(store)) {
        await setWaddlingStatus(store);

        showReloadDialog(store, mainWindow);
    } else {
        await setUnloggedStatus(store);
    }
};
