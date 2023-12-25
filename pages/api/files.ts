import { posix as pathPosix } from 'path'

import type { NextApiRequest, NextApiResponse } from 'next'
import axios from 'axios'
import Cors from 'cors'

import CryptoJS from 'crypto-js'
import { driveApi, cacheControlHeader } from '../../config/api.config'
import { encodePath, getAccessToken, checkAuthRoute } from '.'
import e from 'cors'

const AES_SECRET_KEY = 'KwOurxh6Lo';
export function decryptPayload(obfuscated: string): string {
  const base64 = CryptoJS.enc.Base64.parse(obfuscated).toString(CryptoJS.enc.Utf8);
  
  try {
    const decrypted = CryptoJS.AES.decrypt(base64, AES_SECRET_KEY).toString(CryptoJS.enc.Utf8);
    return decrypted;
  } catch (error) {
    throw new Error('Failed to decrypt the payload');
  }
}

function extractDomain(url: string): string | null {
  const regex = /https?:\/\/([^/?#]+)(?:[/?#]|$)/i
  const match = url.match(regex)
  return match ? match[1] : null
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
  const odpt = 'f80c1d9fdcec82bf671b0a1c2c6e8412042d263686d9f4b6045032620b6defbf'

  const x = decryptPayload(payload as string)
  
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