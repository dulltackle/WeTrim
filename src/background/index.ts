import { openOrFocusAppTab } from './app-tab';

chrome.action.onClicked.addListener(async () => {
  await openOrFocusAppTab();
});
