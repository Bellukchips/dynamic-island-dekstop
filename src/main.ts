import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { initNudge } from "./nudge";
import { initGreeting } from "./greeting";
import { openExternalUrl } from "./open-external";
import { initMoments, setMeetingMode, noteMedia, noteWeather, noteBattery, noteActivity, focusStarted, focusTick, focusFinished } from "./moments";
import { loadFace, saveFace, startClock } from "./clock";
import { initCalendar, goToday, shiftMonth } from "./calendar";
import { initHubNav } from "./hub-nav";
import { initPrayer } from "./prayer";
import { initBottomPlay } from "./bottom-play";
import { getVersion } from "@tauri-apps/api/app";
import { loadRemoteUpdateConfig, type RemoteUpdateConfig } from "./firebase";
import { initEyeBreak } from "./eye-break";
import { initPriceAlert } from "./price-alert";
import { initMoodMouth } from "./mood-mouth";
import { initAdhanFace } from "./adhan-face";
import { initMomentBubble } from "./moment-bubble";
declare global {
    interface Window {
        __NOTCH_UPDATE_CONFIG__?: RemoteUpdateConfig;
    }
}

import * as configState from './main-modules/config-state';
import * as windowLayout from './main-modules/window-layout';
import * as viewController from './main-modules/view-controller';
import * as mood from './main-modules/mood';
import * as hubNavigation from './main-modules/hub-navigation';
import * as hover from './main-modules/hover';
import * as windowDragOrb from './main-modules/window-drag-orb';
import * as notchFace from './main-modules/notch-face';
import * as media from './main-modules/media';
import * as devices from './main-modules/devices';
import * as weatherHud from './main-modules/weather-hud';
import * as pomodoro from './main-modules/pomodoro';
import * as quickStats from './main-modules/quick-stats';
import * as clipboardPrivacy from './main-modules/clipboard-privacy';
import * as lyrics from './main-modules/lyrics';
import * as calendar from './main-modules/calendar';
import * as shelf from './main-modules/shelf';
import * as reminders from './main-modules/reminders';
import * as notes from './main-modules/notes';
import * as keyboardDemo from './main-modules/keyboard-demo';
import * as integrations from './main-modules/integrations';
import * as updates from './main-modules/updates';
import * as bottomPlayStartup from './main-modules/bottom-play-startup';

// Shared runtime state: implementations live in focused modules under main-modules/.
const ctx: Record<string, any> = {
  focusFinished,
  focusStarted,
  focusTick,
  getCurrentWebview,
  getVersion,
  goToday,
  initBottomPlay,
  initCalendar,
  initEyeBreak,
  initGreeting,
  initHubNav,
  initMoments,
  initNudge,
  initPrayer,
  initPriceAlert,
  invoke,
  listen,
  loadFace,
  loadRemoteUpdateConfig,
  noteActivity,
  noteBattery,
  noteMedia,
  noteWeather,
  openExternalUrl,
  saveFace,
  shiftMonth,
  startClock,
  setMomentsMeeting: setMeetingMode
};

// Register function declarations first to preserve their original hoisting behavior.
  configState.register(ctx);
  windowLayout.register(ctx);
  viewController.register(ctx);
  mood.register(ctx);
  hubNavigation.register(ctx);
  hover.register(ctx);
  windowDragOrb.register(ctx);
  notchFace.register(ctx);
  media.register(ctx);
  devices.register(ctx);
  weatherHud.register(ctx);
  pomodoro.register(ctx);
  quickStats.register(ctx);
  clipboardPrivacy.register(ctx);
  lyrics.register(ctx);
  calendar.register(ctx);
  shelf.register(ctx);
  reminders.register(ctx);
  notes.register(ctx);
  keyboardDemo.register(ctx);
  integrations.register(ctx);
  updates.register(ctx);
  bottomPlayStartup.register(ctx);

// Execute module initialization in the same order as the original main.ts.
  configState.init(ctx);
  // Restore the Conversation Moments / Focus Companion speech cloud.
  ctx.momentBubble = initMomentBubble({ shell: ctx.$("shell"), notch: ctx.notch });
  // Restore idle mood-mouth and adhan mouth/face animations.
  initMoodMouth(ctx.eyes);
  ctx.adhanFace = initAdhanFace(ctx.notch, ctx.eyes);
  windowLayout.init(ctx);
  viewController.init(ctx);
  mood.init(ctx);
  hubNavigation.init(ctx);
  hover.init(ctx);
  windowDragOrb.init(ctx);
  notchFace.init(ctx);
  media.init(ctx);
  devices.init(ctx);
  weatherHud.init(ctx);
  pomodoro.init(ctx);
  quickStats.init(ctx);
  clipboardPrivacy.init(ctx);
  lyrics.init(ctx);
  calendar.init(ctx);
  shelf.init(ctx);
  reminders.init(ctx);
  notes.init(ctx);
  keyboardDemo.init(ctx);
  integrations.init(ctx);
  updates.init(ctx);
  bottomPlayStartup.init(ctx);

// Preserve the original public helpers.
export const setBase = (...args: any[]) => ctx.setBase(...args);
export const flash = (...args: any[]) => ctx.flash(...args);
