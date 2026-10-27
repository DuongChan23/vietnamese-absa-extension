// Open the persistent Chrome Side Panel when the extension icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);
