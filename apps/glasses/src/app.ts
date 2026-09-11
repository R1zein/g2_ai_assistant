import {
  AppLocationAccuracy,
  DeviceConnectType,
  OsEventTypeList,
  type DeviceStatus,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';
import type { AgendaItem, AssistantAnswer, AssistantNotification, ClientContext } from '@g2/shared';
import { api, ApiRequestError } from './api';
import { GlassesBridge } from './bridge';
import { Renderer } from './display/renderer';
import { paginate } from './display/text';
import { HostStorage } from './storage';
import { STORAGE_KEYS } from './config';
import { BODY_LINES, BODY_WIDTH, buildPage } from './screens/render';
import { MENU, type Chrome, type View } from './screens/views';
import { VoiceRecorder } from './voice';

export type PanelListener = (state: PanelState) => void;

export interface PanelState {
  status: string;
  account?: string;
  view: View['kind'];
  lastQuestion?: string;
  lastAnswer?: string;
  agenda: AgendaItem[];
  voiceEnabled: boolean;
  pairing?: { code: string; url: string };
  log: string[];
}

const AGENDA_REFRESH_MS = 5 * 60_000;
const LOG_LINES = 40;

/**
 * The application. Owns the view state, the glasses input mapping, and the
 * connection to the assistant server.
 */
export class AssistantApp {
  private bridge!: GlassesBridge;
  private renderer!: Renderer;
  private storage!: HostStorage;
  private voice!: VoiceRecorder;

  private view: View = { kind: 'boot', message: 'Connecting…' };
  private chrome: Chrome = { connected: false };
  private timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  private voiceEnabled = false;

  private agenda: AgendaItem[] = [];
  private conversationId: string | undefined;
  private lastAnswer: AssistantAnswer | undefined;
  /** The view to return to once a notification or answer is dismissed. */
  private resumeView: View | null = null;
  private pairing: { code: string; url: string } | undefined;

  private location: ClientContext['location'];
  private readonly teardown: Array<() => void> = [];
  private agendaTimer: ReturnType<typeof setInterval> | null = null;
  private listeningTimer: ReturnType<typeof setInterval> | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  private closeStream: (() => void) | null = null;
  private readonly logLines: string[] = [];
  private panelListener: PanelListener | null = null;
  private stopped = false;

  /* ---------------- lifecycle ---------------- */

  async start(): Promise<void> {
    this.log('waiting for the Even App bridge');
    this.bridge = await GlassesBridge.connect();
    this.renderer = new Renderer(this.bridge);
    this.storage = new HostStorage(this.bridge.raw);
    this.voice = new VoiceRecorder(this.bridge, () => void this.finishVoice());

    // Register before the first await that could miss it: launch source fires once.
    this.teardown.push(
      this.bridge.raw.onLaunchSource((source) => this.log(`launched from ${source}`)),
    );
    this.teardown.push(this.bridge.raw.onDeviceStatusChanged((s) => this.onDeviceStatus(s)));
    this.teardown.push(this.bridge.raw.onEvenHubEvent((e) => this.onHubEvent(e)));

    // Mounting the startup page is a hard prerequisite for the glasses mic.
    await this.show({ kind: 'boot', message: 'Starting…' });

    try {
      const device = await this.bridge.raw.getDeviceInfo();
      if (device) this.onDeviceStatus(device.status);
    } catch {
      this.log('no device info available');
    }

    const token = await this.storage.sessionToken();
    if (token) {
      api.setToken(token);
      await this.resumeSession();
    } else {
      await this.beginPairing();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.agendaTimer) clearInterval(this.agendaTimer);
    if (this.listeningTimer) clearInterval(this.listeningTimer);
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.closeStream?.();

    // `stop()` can run before `start()` finished wiring everything up.
    await this.voice?.cancel().catch(() => undefined);
    await this.bridge?.run('stopLocation', (b) => b.stopAppLocationUpdates()).catch(() => undefined);

    for (const off of this.teardown.splice(0)) {
      try {
        off();
      } catch {
        // Nothing useful to do while tearing down.
      }
    }
  }

  /* ---------------- session ---------------- */

  private async resumeSession(): Promise<void> {
    await this.show({ kind: 'boot', message: 'Signing in…' });

    try {
      const me = await api.me();
      this.timeZone = me.account.timeZone || this.timeZone;
      this.voiceEnabled = me.voiceEnabled;
      await this.storage.set(STORAGE_KEYS.accountEmail, me.account.email);
      this.log(`signed in as ${me.account.email}`);

      this.openStream();
      this.startLocationUpdates();
      await this.refreshAgenda();
      await this.drainPendingNotifications();

      this.agendaTimer = setInterval(() => void this.refreshAgenda(), AGENDA_REFRESH_MS);
    } catch (err) {
      if (err instanceof ApiRequestError && err.reauth) {
        this.log('session rejected — re-pairing');
        await this.storage.clearSession();
        api.setToken('');
        await this.beginPairing();
        return;
      }
      await this.show({
        kind: 'message',
        title: 'Server unreachable',
        body: `${err instanceof Error ? err.message : 'Unknown error'}\n\nCheck that the assistant server is running and reachable from the phone.`,
      });
    }
  }

  private async beginPairing(): Promise<void> {
    await this.show({ kind: 'boot', message: 'Preparing pairing…' });

    try {
      const deviceId = await this.storage.deviceId();
      const start = await api.startPairing(deviceId, 'Even G2');
      this.pairing = { code: start.pairingCode, url: start.verificationUrl };

      await this.show({
        kind: 'pairing',
        code: start.pairingCode,
        url: start.verificationUrl,
        note: 'The code is also on your phone screen.',
      });

      this.pollPairing(start.pairingCode, start.pollIntervalMs, new Date(start.expiresAt).getTime());
    } catch (err) {
      await this.show({
        kind: 'message',
        title: 'Cannot reach the server',
        body: `${err instanceof Error ? err.message : 'Unknown error'}\n\nThe assistant server has to be reachable from your phone before pairing can start.`,
      });
    }
  }

  private pollPairing(code: string, intervalMs: number, expiresAtMs: number): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) return;

      if (Date.now() > expiresAtMs) {
        this.log('pairing code expired — requesting a new one');
        await this.beginPairing();
        return;
      }

      try {
        const result = await api.pollPairing(code);
        if (result.status === 'linked' && result.sessionToken) {
          await this.storage.setSessionToken(result.sessionToken);
          api.setToken(result.sessionToken);
          this.pairing = undefined;
          this.log(`paired with ${result.account?.email ?? 'your Google account'}`);
          await this.resumeSession();
          return;
        }
        if (result.status === 'expired') {
          await this.beginPairing();
          return;
        }
      } catch {
        // Transient failures are expected while the user is at the consent screen.
      }

      this.pairingTimer = setTimeout(() => void tick(), intervalMs);
    };

    this.pairingTimer = setTimeout(() => void tick(), intervalMs);
  }

  /* ---------------- data ---------------- */

  private async refreshAgenda(): Promise<void> {
    if (!api.hasToken) return;

    try {
      this.setBusy(true);
      const agenda = await api.agenda(48);
      this.agenda = agenda.items;
      this.timeZone = agenda.timeZone || this.timeZone;

      // Only redraw if the wearer is actually looking at the agenda.
      if (this.view.kind === 'agenda' || this.view.kind === 'boot') {
        await this.show({ kind: 'agenda', items: this.agenda, page: 0 });
      } else {
        this.emitPanel();
      }
    } catch (err) {
      this.log(`agenda refresh failed: ${err instanceof Error ? err.message : 'error'}`);
      if (this.view.kind === 'boot') {
        await this.show({
          kind: 'message',
          title: 'Calendar unavailable',
          body: err instanceof Error ? err.message : 'Google Calendar did not respond.',
        });
      }
    } finally {
      this.setBusy(false);
    }
  }

  private async drainPendingNotifications(): Promise<void> {
    try {
      const { notifications } = await api.pendingNotifications();
      if (notifications.length === 0) return;

      const latest = notifications[notifications.length - 1]!;
      await this.showNotification(latest);
      await api.ackNotifications(notifications.map((n) => n.id));
    } catch {
      // Notifications are best-effort; the stream will catch up.
    }
  }

  private openStream(): void {
    this.closeStream?.();
    this.closeStream = api.openStream(
      (event) => {
        if (event.type === 'notification') void this.showNotification(event.notification);
        else if (event.type === 'agenda') {
          this.agenda = event.agenda.items;
          this.emitPanel();
        }
      },
      () => this.log('notification stream dropped — the browser will retry'),
    );
  }

  private startLocationUpdates(): void {
    void this.bridge
      .run('startLocation', (b) =>
        b.startAppLocationUpdates({
          accuracy: AppLocationAccuracy.Medium,
          intervalMs: 60_000,
          distanceFilter: 50,
        }),
      )
      .catch(() => this.log('continuous location unavailable'));

    this.teardown.push(
      this.bridge.raw.onAppLocationChanged((loc) => {
        this.location = {
          latitude: loc.latitude,
          longitude: loc.longitude,
          accuracy: loc.accuracy,
        };
      }),
    );
  }

  /** One-shot read for when the push stream has not produced a fix yet. */
  private async currentLocation(): Promise<ClientContext['location']> {
    if (this.location) return this.location;
    try {
      const fix = await this.bridge.run(
        'getAppLocation',
        (b) => b.getAppLocation({ accuracy: AppLocationAccuracy.Medium, timeoutMs: 4_000 }),
        6_000,
      );
      if (fix) {
        this.location = { latitude: fix.latitude, longitude: fix.longitude, accuracy: fix.accuracy };
      }
    } catch {
      // Location is optional; the assistant is told when it is missing.
    }
    return this.location;
  }

  private async clientContext(): Promise<ClientContext> {
    return {
      location: await this.currentLocation(),
      timeZone: this.timeZone,
      locale: typeof navigator !== 'undefined' ? navigator.language : undefined,
      battery: this.chrome.battery,
    };
  }

  /* ---------------- assistant ---------------- */

  async askText(question: string): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed || !api.hasToken) return;

    await this.show({ kind: 'working', step: 'Thinking…' });
    this.setBusy(true);

    try {
      const answer = await api.ask(trimmed, this.conversationId, await this.clientContext());
      await this.presentAnswer(answer);
    } catch (err) {
      await this.presentError(err);
    } finally {
      this.setBusy(false);
    }
  }

  private async startVoice(): Promise<void> {
    if (!api.hasToken || this.voice.isRecording) return;

    if (!this.voiceEnabled) {
      await this.show({
        kind: 'message',
        title: 'Voice is off',
        body: 'This server has no speech provider configured.\nSet STT_PROVIDER on the server, or type a question in the phone panel.',
      });
      return;
    }

    // Remember where to go back to if the capture turns out to be empty.
    if (this.view.kind !== 'listening' && this.view.kind !== 'working') this.resumeView = this.view;

    const started = await this.voice.start();
    if (!started) {
      await this.show({
        kind: 'message',
        title: 'Microphone unavailable',
        body: 'The glasses microphone did not open. Check the g2-microphone permission and that the glasses are connected.',
      });
      return;
    }

    await this.show({ kind: 'listening', seconds: 0 });
    this.listeningTimer = setInterval(() => {
      if (this.view.kind !== 'listening') return;
      void this.show({ kind: 'listening', seconds: Math.floor(this.voice.elapsedSeconds) });
    }, 1_000);
  }

  private async finishVoice(): Promise<void> {
    if (!this.voice.isRecording) return;

    if (this.listeningTimer) {
      clearInterval(this.listeningTimer);
      this.listeningTimer = null;
    }

    const capture = await this.voice.stop();
    if (!capture) {
      await this.show(this.resumeView ?? { kind: 'agenda', items: this.agenda, page: 0 });
      return;
    }

    await this.show({ kind: 'working', step: 'Transcribing…' });
    this.setBusy(true);

    try {
      const answer = await api.askVoice(
        capture.base64,
        capture.sampleRate,
        this.conversationId,
        await this.clientContext(),
      );
      await this.presentAnswer(answer);
    } catch (err) {
      await this.presentError(err);
    } finally {
      this.setBusy(false);
    }
  }

  private async presentAnswer(answer: AssistantAnswer): Promise<void> {
    this.conversationId = answer.conversationId;
    this.lastAnswer = answer;
    this.log(
      `"${answer.question}" -> ${answer.meta.latencyMs}ms, ` +
        `${answer.steps.length} tool call(s), ${answer.meta.model}`,
    );

    await this.show({
      kind: 'answer',
      question: answer.question,
      pages: paginate(answer.answer, BODY_WIDTH, BODY_LINES),
      page: 0,
    });
  }

  private async presentError(err: unknown): Promise<void> {
    if (err instanceof ApiRequestError && err.reauth) {
      await this.storage.clearSession();
      api.setToken('');
      await this.beginPairing();
      return;
    }

    const message = err instanceof Error ? err.message : 'Something went wrong.';
    this.log(`request failed: ${message}`);
    await this.show({ kind: 'message', title: 'Could not answer', body: message });
  }

  private async showNotification(notification: AssistantNotification): Promise<void> {
    if (this.view.kind === 'listening') return; // never interrupt a capture

    if (this.view.kind !== 'notification') this.resumeView = this.view;
    await this.show({ kind: 'notification', notification });
  }

  /* ---------------- input ---------------- */

  private onDeviceStatus(status: DeviceStatus): void {
    this.chrome = {
      ...this.chrome,
      connected: status.connectType === DeviceConnectType.Connected,
      battery: status.batteryLevel,
    };
    void this.paint();
  }

  private onHubEvent(event: EvenHubEvent): void {
    this.voice.accept(event);

    if (event.menuItemClickEvent) {
      void this.onMenu(event.menuItemClickEvent.itemID ?? 0);
      return;
    }

    if (event.textEvent) {
      // Only scroll gestures arrive here; taps come through sysEvent.
      const type = event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT;
      if (type === OsEventTypeList.SCROLL_TOP_EVENT) void this.turnPage(-1);
      else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) void this.turnPage(1);
      return;
    }

    if (event.sysEvent) {
      // Protobuf omits zero values, so an undefined eventType is CLICK.
      const type = event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT;
      switch (type) {
        case OsEventTypeList.CLICK_EVENT:
          void this.onTap();
          return;
        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          // Let the OS own the confirmation; we clean up on the exit event.
          void this.bridge.run('shutDown', (b) => b.shutDownPageContainer(1));
          return;
        case OsEventTypeList.LONG_PRESS_EVENT:
          void this.startVoice();
          return;
        case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
          void this.finishVoice();
          return;
        case OsEventTypeList.FOREGROUND_ENTER_EVENT:
          void this.paint();
          void this.refreshAgenda();
          return;
        case OsEventTypeList.FOREGROUND_EXIT_EVENT:
          void this.voice.cancel();
          return;
        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
        case OsEventTypeList.SYSTEM_EXIT_EVENT:
          void this.stop();
          return;
        default:
          return;
      }
    }
  }

  private async onTap(): Promise<void> {
    switch (this.view.kind) {
      case 'notification':
        await this.show(this.resumeView ?? { kind: 'agenda', items: this.agenda, page: 0 });
        this.resumeView = null;
        return;
      case 'answer':
        await this.show({ kind: 'agenda', items: this.agenda, page: 0 });
        return;
      case 'agenda':
        await this.turnPage(1);
        return;
      case 'message':
        await this.show({ kind: 'agenda', items: this.agenda, page: 0 });
        return;
      default:
        return;
    }
  }

  private async turnPage(delta: number): Promise<void> {
    if (this.view.kind === 'answer') {
      const next = Math.min(Math.max(0, this.view.page + delta), this.view.pages.length - 1);
      if (next === this.view.page) return;
      await this.show({ ...this.view, page: next });
      return;
    }

    if (this.view.kind === 'agenda') {
      const totalPages = Math.max(1, Math.ceil(this.view.items.length / BODY_LINES));
      const next = (this.view.page + delta + totalPages) % totalPages;
      if (next === this.view.page) return;
      await this.show({ ...this.view, page: next });
    }
  }

  private async onMenu(itemId: number): Promise<void> {
    switch (itemId) {
      case MENU.ask:
        await this.startVoice();
        return;
      case MENU.agenda:
        await this.refreshAgenda();
        await this.show({ kind: 'agenda', items: this.agenda, page: 0 });
        return;
      case MENU.brief:
        await this.askText(
          'Give me a brief for the next 24 hours: what is coming up, anything I need to leave early for, and anything unusual.',
        );
        return;
      case MENU.syncMail:
        await this.runMailSync();
        return;
      case MENU.account:
        await this.showAccount();
        return;
      case MENU.exit:
        await this.bridge.run('shutDown', (b) => b.shutDownPageContainer(1));
        return;
      default:
        return;
    }
  }

  private async runMailSync(): Promise<void> {
    await this.show({ kind: 'working', step: 'Scanning your mail…' });
    this.setBusy(true);

    try {
      const result = await api.sync();
      await this.refreshAgenda();
      await this.show({
        kind: 'message',
        title: 'Mail scanned',
        body: [
          `${result.scannedMessages} message(s) read`,
          `${result.newBookings} new booking(s)`,
          `${result.updatedBookings} updated`,
          result.errors.length > 0 ? `${result.errors.length} error(s)` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });
    } catch (err) {
      await this.presentError(err);
    } finally {
      this.setBusy(false);
    }
  }

  private async showAccount(): Promise<void> {
    try {
      const me = await api.me();
      await this.show({
        kind: 'message',
        title: 'Account',
        body: [
          me.account.email,
          `Timezone ${me.account.timeZone}`,
          `${me.bookings} saved booking(s)`,
          me.lastGmailSyncAt ? `Mail scanned ${new Date(me.lastGmailSyncAt).toLocaleString()}` : 'Mail not scanned yet',
          me.voiceEnabled ? 'Voice input on' : 'Voice input off',
        ].join('\n'),
      });
    } catch (err) {
      await this.presentError(err);
    }
  }

  /* ---------------- rendering ---------------- */

  private async show(view: View): Promise<void> {
    this.view = view;
    await this.paint();
  }

  private async paint(): Promise<void> {
    this.emitPanel();
    if (this.stopped) return;

    try {
      await this.renderer.render(
        buildPage({
          view: this.view,
          chrome: this.chrome,
          timeZone: this.timeZone,
          voiceEnabled: this.voiceEnabled,
        }),
      );
    } catch (err) {
      this.log(`render failed: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  private setBusy(busy: boolean): void {
    this.chrome = { ...this.chrome, busy };
    void this.paint();
  }

  /* ---------------- phone panel ---------------- */

  onPanelUpdate(listener: PanelListener): void {
    this.panelListener = listener;
    this.emitPanel();
  }

  /** Lets the phone-side panel drive the same actions as the glasses menu. */
  async panelAction(action: 'ask' | 'agenda' | 'sync' | 'unpair', payload?: string): Promise<void> {
    switch (action) {
      case 'ask':
        if (payload) await this.askText(payload);
        else await this.startVoice();
        return;
      case 'agenda':
        await this.refreshAgenda();
        await this.show({ kind: 'agenda', items: this.agenda, page: 0 });
        return;
      case 'sync':
        await this.runMailSync();
        return;
      case 'unpair':
        try {
          await api.unpair();
        } catch {
          // Local state is cleared regardless.
        }
        await this.storage.clearSession();
        api.setToken('');
        this.conversationId = undefined;
        await this.beginPairing();
        return;
    }
  }

  private log(line: string): void {
    const stamped = `${new Date().toLocaleTimeString()}  ${line}`;
    this.logLines.push(stamped);
    if (this.logLines.length > LOG_LINES) this.logLines.shift();
    console.log(`[assistant] ${line}`);
    this.emitPanel();
  }

  private emitPanel(): void {
    this.panelListener?.({
      status: describeStatus(this.view, this.chrome),
      view: this.view.kind,
      lastQuestion: this.lastAnswer?.question,
      lastAnswer: this.lastAnswer?.answer,
      agenda: this.agenda,
      voiceEnabled: this.voiceEnabled,
      pairing: this.pairing,
      log: [...this.logLines].reverse(),
    });
  }
}

function describeStatus(view: View, chrome: Chrome): string {
  if (view.kind === 'pairing') return 'waiting for sign-in';
  if (view.kind === 'listening') return 'listening';
  if (view.kind === 'working') return view.step;
  if (chrome.busy) return 'working';
  return chrome.connected ? 'connected' : 'glasses offline';
}
