import { InquiryInbox } from './inquiry-inbox.js';
import { NaverInquiryAdapter } from './naver-inquiry-adapter.js';

export class NaverInquiryInbox extends InquiryInbox {
  constructor(directory, connector, queue, adapter = new NaverInquiryAdapter(connector)) {
    super(directory, adapter, queue);
  }
}
