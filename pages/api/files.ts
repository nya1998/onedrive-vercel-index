import { posix as pathPosix } from 'path'

import type { NextApiRequest, NextApiResponse } from 'next'
import axios from 'axios'
import Cors from 'cors'

import CryptoJS from 'crypto-js'
import { driveApi, cacheControlHeader } from '../../config/api.config'
import { encodePath, getAccessToken, checkAuthRoute } from '.'
import e from 'cors'

const AES_SECRET_KEY = 'KwOurxh6Lo'
export function decryptPayload(obfuscated: string): string {
  try {
    // Decrypt AES + Base64 obfuscated token
    const base64 = CryptoJS.enc.Base64.parse(obfuscated)
    const parseb64 = base64.toString(CryptoJS.enc.Utf8)
    const decrypted = CryptoJS.AES.decrypt(parseb64, AES_SECRET_KEY)
    return decrypted.toString(CryptoJS.enc.Utf8)
  } catch (error) {
    return ''
  }
}

// CORS middleware for raw links: https://nextjs.org/docs/api-routes/api-middlewares
export function runCorsMiddleware(req: NextApiRequest, res: NextApiResponse) {
  const cors = Cors({ methods: ['GET', 'HEAD'] })
  return new Promise((resolve, reject) => {
    cors(req, res, result => {
      if (result instanceof Error) {
        return reject(result)
      }

      return resolve(result)
    })
  })
}


export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const accessToken = await getAccessToken()
  if (!accessToken) {
    res.status(403).json({ error: 'No access token.' })
    return
  }

  const { payload = '', proxy = false } = req.query
  const odpt = 'c202498aea9cd692709d37368b7b617ea30c147e5f6b2bc32d5a742aac85d717'

  const x = decryptPayload(payload as string)
  const refer = req.headers['referer']

  // Sometimes the path parameter is defaulted to '[...path]' which we need to handle
  if (payload === '[...path]') {
    res.status(400).json({ error: 'No path specified.' })
    return
  }
  // If the path is not a valid path, return 400
  if (typeof payload !== 'string') {
    res.status(400).json({ error: 'Path query invalid.' })
    return
  }
  const cleanPath = pathPosix.resolve('/', pathPosix.normalize(x))

  // Handle protected routes authentication
  const odTokenHeader = (req.headers['od-protected-token'] as string) ?? odpt

  const { code, message } = await checkAuthRoute(x, accessToken, odTokenHeader)
  // Status code other than 200 means user has not authenticated yet
  if (code !== 200) {
    res.status(code).json({ error: message })
    return
  }
  // If message is empty, then the path is not protected.
  // Conversely, protected routes are not allowed to serve from cache.
  if (message !== '') {
    res.setHeader('Cache-Control', 'no-cache')
  }

  //Referer check and empty payload handling
  if (!refer?.includes('carapedi.id') && !refer?.includes('go.bicolink.net')) {
    res.status(403).json({ error: 'Sepertinya anda bukan dari beruanglaut. Hanya download dari beruanglaut, bukan yang lain. Jika sudah, coba ganti browser yang anda gunakan.' })
    return
  } else if(x == ""){
    res.status(400).json({ error: 'Invalid Payload' })
    return
  } else {
    await runCorsMiddleware(req, res)
    try {
      // Handle response from OneDrive API
      const requestUrl = `${driveApi}/root${encodePath(cleanPath)}`
      const { data } = await axios.get(requestUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          // OneDrive international version fails when only selecting the downloadUrl (what a stupid bug)
          select: 'id,size,@microsoft.graph.downloadUrl',
        },
      })

      if ('@microsoft.graph.downloadUrl' in data) {
        // Only proxy raw file content response for files up to 4MB
        if (proxy && 'size' in data && data['size'] < 4194304) {
          const { headers, data: stream } = await axios.get(data['@microsoft.graph.downloadUrl'] as string, {
            responseType: 'stream',
          })
          headers['Cache-Control'] = cacheControlHeader
          // Send data stream as response
          res.writeHead(200, headers)
          stream.pipe(res)
        } else {
          res.redirect(data['@microsoft.graph.downloadUrl'])
        }
      } else {
        res.status(404).json({ error: 'File Not Found.', referer: x })
      }
      return
    } catch (error: any) {
      res.status(error?.response?.status ?? 500).json({ error: error?.response?.data ?? 'Internal server error.' })
      return
    }
  }
}