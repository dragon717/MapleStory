export function isChatLogAtBottom(log: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>) {
  return log.scrollHeight - log.scrollTop - log.clientHeight <= 1;
}

export function appendChatLogLine(log: HTMLDivElement, line: HTMLElement) {
  const follow = isChatLogAtBottom(log);
  log.append(line);
  while (log.childElementCount > 40) log.firstElementChild?.remove();
  if (follow) log.scrollTop = log.scrollHeight;
}
