import { randomInt } from "node:crypto";
import { RtpHeader, RtpPacket } from "werift";
import { H264AnnexBParser } from "werift/nonstandard";
import type { H264Frame } from "./frame-stream.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 1_200;

export class H264RtpPacketizer {
  private sequenceNumber = randomInt(0x1_0000);

  constructor(
    private readonly payloadType = 96,
    private readonly maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  ) {
    if (maxPayloadBytes < 3) throw new RangeError("H.264 RTP payload size is too small");
  }

  packetize(frame: H264Frame): RtpPacket[] {
    const parser = new H264AnnexBParser(frame.data);
    const nalUnits: Buffer[] = [];
    let payload = parser.readNextNaluPayload();
    while (payload) {
      nalUnits.push(Buffer.from(payload.data));
      payload = parser.readNextNaluPayload();
    }
    if (nalUnits.length === 0) throw new Error("H.264 frame contains no Annex B NAL units");

    const packets: RtpPacket[] = [];
    nalUnits.forEach((nalUnit, nalIndex) => {
      const lastNal = nalIndex === nalUnits.length - 1;
      if (nalUnit.byteLength <= this.maxPayloadBytes) {
        packets.push(this.packet(nalUnit, frame.timestamp90k, lastNal));
        return;
      }

      const nalHeader = nalUnit[0]!;
      const fragment = nalUnit.subarray(1);
      const chunkBytes = this.maxPayloadBytes - 2;
      const fuIndicator = (nalHeader & 0xe0) | 28;
      const nalType = nalHeader & 0x1f;
      for (let offset = 0; offset < fragment.byteLength; offset += chunkBytes) {
        const chunk = fragment.subarray(offset, Math.min(fragment.byteLength, offset + chunkBytes));
        const lastFragment = offset + chunk.byteLength >= fragment.byteLength;
        const fuHeader = (offset === 0 ? 0x80 : 0) | (lastFragment ? 0x40 : 0) | nalType;
        packets.push(this.packet(
          Buffer.concat([Buffer.from([fuIndicator, fuHeader]), chunk]),
          frame.timestamp90k,
          lastNal && lastFragment,
        ));
      }
    });
    return packets;
  }

  private packet(payload: Buffer, timestamp: number, marker: boolean): RtpPacket {
    const packet = new RtpPacket(new RtpHeader({
      payloadType: this.payloadType,
      sequenceNumber: this.sequenceNumber,
      timestamp,
      marker,
    }), payload);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    return packet;
  }
}
