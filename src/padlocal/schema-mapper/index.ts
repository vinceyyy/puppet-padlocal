import { ChatRoomMember, Contact, Message } from 'padlocal-client-ts/dist/proto/padlocal_pb'
import {
  ContactPayload,
  ContactType,
  log,
  MessagePayload,
  MessageType,
  Puppet,
  RoomMemberPayload,
  RoomPayload,
} from 'wechaty-puppet'
import { isContactId, isContactOfficialId, isIMContactId, isIMRoomId, isRoomId } from '../utils/is-type'
import { MessagePayloadBase } from 'wechaty-puppet/dist/src/schemas/message'
import { convertMessageType } from '../message-parser/helpers/message'
import { appMessageParser, AppMessageType } from '../message-parser/helpers/message-appmsg'
import { WechatMessageType } from '../message-parser/WechatMessageType'
import { isPatMessage, patMessageParser } from '../message-parser/helpers/message-pat'

const PRE = '[SchemaMapper]'

export async function padLocalMessageToWechaty (puppet: Puppet, message: Message.AsObject): Promise<MessagePayload> {
  const wechatMessageType = message.type as WechatMessageType
  const type = convertMessageType(wechatMessageType)

  const payloadBase: MessagePayloadBase = {
    id: message.id,
    timestamp: message.createtime,
    type,
  }

  /**
   * fromId: is mandatory
   * roomId or toId: is mandatory
   */
  let fromId: undefined | string
  let roomId: undefined | string
  let toId: undefined | string

  let text: undefined | string
  let mentionIdList: string[] = []

  // enterprise wechat
  if (isRoomId(message.fromusername) || isIMRoomId(message.fromusername)) {
    roomId = message.fromusername

    // text:    "wxid_xxxx:\nnihao"
    // appmsg:  "wxid_xxxx:\n<?xml version="1.0"?><msg><appmsg appid="" sdkver="0">..."
    // pat:     "19850419xxx@chatroom:\n<sysmsg type="pat"><pat><fromusername>xxx</fromusername><chatusername>19850419xxx@chatroom</chatusername><pattedusername>wxid_xxx</pattedusername>...<template><![CDATA["${vagase}" 拍了拍我]]></template></pat></sysmsg>"

    const parts = message.content.split(':\n')
    if (parts && parts.length > 1) {
      if (isContactId(parts[0]) || isIMContactId(parts[0])) {
        fromId = parts[0]
        text = parts[1]
      }
      // pat message
      else if (isRoomId(parts[0]) || isIMRoomId(parts[0])) {
        const patMessage = await isPatMessage(message)
        if (patMessage) {
          const patMessagePayload = await patMessageParser(message)
          fromId = patMessagePayload.fromusername
          text = patMessagePayload.template
        }
      }
    }
  } else if (isRoomId(message.tousername) || isIMRoomId(message.tousername)) {
    roomId = message.tousername
    fromId = message.fromusername

    const startIndex = message.content.indexOf(':\n')
    text = message.content.slice(startIndex !== -1 ? startIndex + 2 : 0)
  } else {
    fromId = message.fromusername
    toId = message.tousername
  }

  if (!text) {
    text = message.content
  }

  // set mention list
  if (roomId) {
    if (message.atList.length === 1 && message.atList[0] === 'announcement@all') {
      const roomPayload = await puppet.roomPayload(roomId)
      mentionIdList = roomPayload.memberIdList
    } else {
      mentionIdList = message.atList
    }
  }

  /**
   * 7. Set text for quote message
   */
  // TODO:
  /*
  if (rawPayload.appMsgType === WechatAppMessageType.QuoteMessage) {
    text = await quotePayloadParser(rawPayload);
  }
   */

  let payload: MessagePayload

  // Two branch is the same code.
  // Only for making TypeScript happy
  if (fromId && toId) {
    payload = {
      ...payloadBase,
      fromId,
      mentionIdList,
      roomId,
      text,
      toId,
    }
  } else if (roomId) {
    payload = {
      ...payloadBase,
      fromId,
      mentionIdList,
      roomId,
      text,
      toId,
    }
  } else {
    throw new Error('neither toId nor roomId')
  }

  await _adjustMessageByAppMsg(message, payload)

  return payload
}

export function padLocalContactToWechaty (contact: Contact.AsObject): ContactPayload {
  return {
    id: contact.username,
    gender: contact.gender,
    type: isContactOfficialId(contact.username) ? ContactType.Official : ContactType.Individual,
    name: contact.nickname,
    avatar: contact.avatar,
    alias: contact.remark,
    weixin: contact.alias,
    city: contact.city,
    friend: !contact.stranger,
    province: contact.province,
    signature: contact.signature,
    phone: contact.phoneList,
  }
}

export function padLocalRoomToWechaty (contact: Contact.AsObject): RoomPayload {
  return {
    adminIdList: [],
    avatar: contact.avatar,
    id: contact.username,
    memberIdList: contact.chatroommemberList.map((member) => member.username),
    ownerId: contact.chatroomownerusername,
    topic: contact.nickname,
  }
}

export function padLocalRoomMemberToWechaty (chatRoomMember: ChatRoomMember.AsObject): RoomMemberPayload {
  return {
    id: chatRoomMember.username,
    roomAlias: chatRoomMember.displayname,
    inviterId: chatRoomMember.inviterusername,
    avatar: chatRoomMember.avatar,
    name: chatRoomMember.nickname,
  }
}

async function _adjustMessageByAppMsg (message: Message.AsObject, payload: MessagePayload) {
  if (payload.type !== MessageType.Attachment) {
    return
  }

  try {
    const appPayload = await appMessageParser(message)
    switch (appPayload.type) {
      case AppMessageType.Text:
        payload.type = MessageType.Text
        payload.text = appPayload.title
        break
      case AppMessageType.Audio:
        payload.type = MessageType.Url
        break
      case AppMessageType.Video:
        payload.type = MessageType.Url
        break
      case AppMessageType.Url:
        payload.type = MessageType.Url
        break
      case AppMessageType.Attach:
        payload.type = MessageType.Attachment
        payload.filename = appPayload.title
        break
      case AppMessageType.ChatHistory:
        payload.type = MessageType.ChatHistory
        break
      case AppMessageType.MiniProgram:
      case AppMessageType.MiniProgramApp:
        payload.type = MessageType.MiniProgram
        break
      case AppMessageType.RedEnvelopes:
        payload.type = MessageType.RedEnvelope
        break
      case AppMessageType.Transfers:
        payload.type = MessageType.Transfer
        break
      case AppMessageType.RealtimeShareLocation:
        payload.type = MessageType.Location
        break
      case AppMessageType.GroupNote:
        payload.type = MessageType.GroupNote
        payload.text = appPayload.title
        break
      case AppMessageType.ReferMsg:
        payload.type = MessageType.Text
        payload.text = `「${appPayload.refermsg!.displayname}：${
          appPayload.refermsg!.content
        }」\n- - - - - - - - - - - - - - - -\n${appPayload.title}`
        break
      default:
        payload.type = MessageType.Unknown
        break
    }
  } catch (e) {
    log.warn(PRE, `Error occurred while parse message attachment: ${JSON.stringify(message)} , ${(e as Error).stack}`)
  }
}

export function chatRoomMemberToContact (chatRoomMember: ChatRoomMember): Contact {
  return new Contact()
    .setUsername(chatRoomMember.getUsername())
    .setNickname(chatRoomMember.getNickname())
    .setAvatar(chatRoomMember.getAvatar())
    .setStranger(true)
}
