import { ref } from 'vue';

/**
 * True while a phone-sized viewport is inside one conversation.
 *
 * The conversation is a second-level page in the WeChat sense: the bottom tab
 * bar folds away and the transcript owns the screen until the reader taps 返回.
 * App.vue owns the chrome, ChatPanel owns the flag.
 */
export const mobileChatDetailOpen = ref(false);
