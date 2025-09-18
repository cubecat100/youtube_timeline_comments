document.getElementById('inject').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // content script로 메시지 전송
  await chrome.tabs.sendMessage(tab.id, { type: 'POPUP_PING', msg: '안녕하세요!' });
});
