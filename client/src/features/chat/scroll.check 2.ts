import { appendChatLogLine, isChatLogAtBottom } from './scroll.ts';

if (!isChatLogAtBottom({ scrollHeight: 66, scrollTop: 0, clientHeight: 66 })) throw new Error('Bottom detection failed');
if (!isChatLogAtBottom({ scrollHeight: 100, scrollTop: 33, clientHeight: 66 })) throw new Error('Bottom tolerance failed');
if (isChatLogAtBottom({ scrollHeight: 100, scrollTop: 20, clientHeight: 66 })) throw new Error('History position should not follow');

const makeLog = (scrollTop: number) => {
  const log = {
    scrollHeight: 100,
    scrollTop,
    clientHeight: 66,
    childElementCount: 0,
    firstElementChild: null,
    append() {
      log.scrollHeight += 11;
      log.childElementCount += 1;
    },
  };
  return log as unknown as HTMLDivElement;
};

const bottomLog = makeLog(34);
appendChatLogLine(bottomLog, {} as HTMLElement);
if (bottomLog.scrollTop !== bottomLog.scrollHeight) throw new Error('Bottom append did not follow');

const historyLog = makeLog(20);
appendChatLogLine(historyLog, {} as HTMLElement);
if (historyLog.scrollTop !== 20) throw new Error('History append should not follow');
console.log('Chat log bottom-follow detection passed.');
