import { ref } from 'vue';

/**
 * True while a phone-sized viewport is inside one conversation.
 *
 * The conversation is a second-level page in the WeChat sense: the bottom tab
 * bar is covered by the page and the transcript owns the screen until the
 * reader taps 返回.
 */
export const mobileChatDetailOpen = ref(false);

/**
 * Horizontal offset of the list page behind an open conversation, in px.
 *
 * ChatPanel publishes it on every frame of the push/pop animation (including
 * an iOS-style back-swipe); App.vue applies the same transform to the global
 * header and tab bar so the whole page travels together instead of the chrome
 * standing still while only the list moves.
 */
export const mobileChatShift = ref(0);

/** True while `mobileChatShift` is tweened; false while a finger drives it. */
export const mobileChatAnimating = ref(false);
