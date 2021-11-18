import axios, { CancelToken } from 'axios'
const instance = axios.create({})

export function handleFileChangeUpload( // 选择文件的初始处理函数
  files, // 上传的文件列表
  limit = 3, // 限制文件上传的个数
  chunkSize = 50 * 1024 * 1024, //切片大小
  threads = 3, //上传并发数
  chunkRetry = 3 //错误重试次数
) {
  instance.defaults.baseURL = 'http://localhost:3001'

  const Status = {
    wait: 'wait',
    pause: 'pause',
    uploading: 'uploading',
    hash: 'hash',
    error: 'error',
    done: 'done'
  }

  // 单个文件的状态
  const fileStatus = {
    wait: 'wait',
    uploading: 'uploading',
    success: 'success',
    error: 'error',
    secondPass: 'secondPass',
    pause: 'pause',
    resume: 'resume'
  }
  // 单个文件的状态 对应描述
  const fileStatusStr = {
    wait: '待上传',
    uploading: '上传中',
    success: '成功',
    error: '失败',
    secondPass: '已秒传',
    pause: '暂停',
    resume: '恢复'
  }

  let worker = null, //计算hash值
    uploadFiles = [], //上传文件列表
    cancels = [], // 存储要取消的请求
    status = Status.wait, //所有文件的状态控制
    tempThreads = threads // 并发数

  let fileIndex = 0 // 当前处理的文件下标
  console.log('handleFileChange -> file', files)
  if (!files) return

  // 判断文件选择的个数
  if (limit && files.length > limit) {
    alert('文件数大于限制')
    return
  }
  const postFiles = Array.prototype.slice.call(files)
  console.log('handleFileChange -> postFiles', postFiles)
  postFiles.forEach((item) => {
    handleStart(item)
  })
  handleUpload()

  function handleStart(rawFile) {
    // 初始化部分自定义属性
    rawFile.status = fileStatus.wait
    rawFile.chunkList = []
    rawFile.uploadProgress = 0
    rawFile.fakeUploadProgress = 0 // 假进度条，处理恢复上传后，进度条后移的问题
    rawFile.hashProgress = 0

    uploadFiles.push(rawFile)
  }

  async function handleUpload() {
    console.log('handleUpload -> uploadFiles', uploadFiles.length)
    if (!uploadFiles) return
    status = Status.uploading
    const filesArr = uploadFiles

    for (let i = 0; i < filesArr.length; i++) {
      fileIndex = i
      if (['secondPass', 'success', 'error'].includes(filesArr[i].status)) {
        console.log('跳过已上传成功或已秒传的或失败的')
        continue
      }

      const fileChunkList = await createFileChunk(filesArr[i])

      // 若不是恢复，再进行hash计算
      if (filesArr[i].status !== 'resume') {
        status = Status.hash
        // hash校验，是否为秒传
        filesArr[i].hash = await calculateHash(fileChunkList)

        // 若清空或者状态为等待，则跳出循环
        if (status === Status.wait) {
          console.log('若清空或者状态为等待，则跳出循环')
          break
        }

        console.log('handleUpload -> hash', filesArr[i].hash)
      }

      status = Status.uploading

      const verifyRes = await verifyUpload(filesArr[i].name, filesArr[i].hash)
      if (verifyRes.data.presence) {
        filesArr[i].status = fileStatus.secondPass
        filesArr[i].uploadProgress = 100
        isAllStatus()
      } else {
        console.log('开始上传文件----》', filesArr[i].name)
        filesArr[i].status = fileStatus.uploading

        const getChunkStorageObj = getChunkStorage(filesArr[i].hash)
        // filesArr[i].fileHash = filesArr[i].hash // 文件的hash，合并时使用
        filesArr[i].chunkList = fileChunkList.map(({ file }, index) => ({
          fileHash: filesArr[i].hash,
          fileName: filesArr[i].name,
          index,
          hash: filesArr[i].hash + '-' + index,
          chunk: file,
          size: file.size,
          uploaded: getChunkStorageObj && getChunkStorageObj.includes(index), // 标识：是否已完成上传
          progress:
            getChunkStorageObj && getChunkStorageObj.includes(index) ? 100 : 0,
          status:
            getChunkStorageObj && getChunkStorageObj.includes(index)
              ? 'success'
              : 'wait' // 上传状态，用作进度状态显示
        }))

        console.log('handleUpload ->  chunkData', filesArr[i])
        await uploadChunks(filesArr[i])
      }
    }
  }
  // 将切片传输给服务端
  async function uploadChunks(data) {
    console.log('uploadChunks -> data', data)
    const chunkData = data.chunkList
    const requestDataList = chunkData
      .filter(({ uploaded }) => !uploaded)
      .map(({ fileHash, chunk, fileName, index, hash }) => {
        const formData = new FormData()
        formData.append('md5', fileHash)
        formData.append('file', chunk)
        formData.append('hash', hash)
        formData.append('currentFileName', fileName)
        return { formData, index }
      })

    console.log('uploadChunks -> requestDataList', requestDataList)
    try {
      const ret = await sendRequest(requestDataList, chunkData)
      console.log('uploadChunks -> chunkData', chunkData)
      console.log('ret', ret)
    } catch (error) {
      // 上传有被reject的
      return
    }

    // 合并切片
    const isUpload = chunkData.some((item) => item.uploaded === false)
    console.log('created -> isUpload', isUpload)
    if (isUpload) {
      alert('存在失败的切片')
    } else {
      // 执行合并
      try {
        await mergeRequest(data)
      } catch (error) {}
    }
  }
  // 并发处理
  function sendRequest(forms, chunkData) {
    console.log('sendRequest -> forms', forms)
    console.log('sendRequest -> chunkData', chunkData)
    let finished = 0
    const total = forms.length
    const retryArr = [] // 数组存储每个文件hash请求的重试次数

    return new Promise((resolve, reject) => {
      const handler = () => {
        // 并发处理文件的每个分片
        console.log('handler -> forms', forms)
        if (forms.length) {
          // 出栈
          const formInfo = forms.shift()
          const formData = formInfo.formData
          const index = formInfo.index

          instance
            .post('fileChunk', formData, {
              onUploadProgress: createProgresshandler(chunkData[index]),
              cancelToken: new CancelToken((c) => cancels.push(c)),
              timeout: 0
            })
            .then((res) => {
              console.log('handler -> res', res)
              // 更改状态
              chunkData[index].uploaded = true
              chunkData[index].status = 'success'

              // 存储已上传的切片下标
              addChunkStorage(chunkData[index].fileHash, index)

              finished++
              handler()
            })
            .catch((e) => {
              // 若状态为暂停或等待，则禁止重试
              console.log('handler -> status', status)
              if ([Status.pause, Status.wait].includes(status)) return

              console.warn('出现错误', e)
              console.log('handler -> retryArr', retryArr)
              if (typeof retryArr[index] !== 'number') {
                retryArr[index] = 0
              }

              // 更新状态
              chunkData[index].status = 'warning'

              // 累加错误次数
              retryArr[index]++

              // 重试3次
              if (retryArr[index] >= chunkRetry) {
                console.warn(
                  ' 重试失败--- > handler -> retryArr',
                  retryArr,
                  chunkData[index].hash
                )
                return reject('重试失败', retryArr)
              }

              console.log(
                'handler -> retryArr[finished]',
                `${chunkData[index].hash}--进行第 ${retryArr[index]} '次重试'`
              )
              console.log(retryArr)

              tempThreads++ // 释放当前占用的通道

              // 将失败的重新加入队列
              forms.push(formInfo)
              handler()
            })
        }

        if (finished >= total) {
          resolve('done')
        }
      }

      // 控制并发
      for (let i = 0; i < tempThreads; i++) {
        handler()
      }
    })
  }
  // 通知服务端合并切片
  function mergeRequest(data) {
    console.log('Merge Chunk', data)
    return new Promise((resolve, reject) => {
      const obj = {
        md5: data.hash,
        fileName: data.name,
        fileChunkNum: chunkSize
      }

      instance
        .post('fileChunk/merge', obj, {
          timeout: 0
        })
        .then((res) => {
          // 清除storage
          if (res.data.code === 2000) {
            data.status = fileStatus.success
            console.log('mergeRequest -> data', data)
            isAllStatus()
            console.log('Merge End!')
          } else {
            // 文件块数量不对，清除缓存
            data.status = fileStatus.error
            status = Status.wait
          }
          clearLocalStorage(data.hash)
          resolve()
        })
        .catch((err) => {
          console.log('mergeRequest -> err', err)
          data.status = fileStatus.error
          reject()
        })
    })
  }
  async function createFileChunk(file, size = chunkSize) {
    const fileChunkList = []
    let count = 0
    while (count < file.size) {
      fileChunkList.push({
        file: file.slice(count, count + size)
      })
      count += size
    }
    console.log('createFileChunk -> fileChunkList', fileChunkList)
    return fileChunkList
  }

  function addChunkStorage(name, index) {
    const data = [index]
    console.log('addChunkStorage -> name, data', name, data)
    const arr = getObjArr(name)
    if (arr) {
      saveObjArr(name, [...arr, ...data])
    } else {
      saveObjArr(name, data)
    }
  }
  function clearLocalStorage(name) {
    localStorage.removeItem(name)
  }
  async function calculateHash(fileChunkList) {
    console.log('calculateHash -> fileChunkList', fileChunkList)
    return new Promise((resolve) => {
      worker = new Worker('./hash.js')
      worker.postMessage({ fileChunkList })
      worker.onmessage = (e) => {
        const { percentage, hash } = e.data
        if (uploadFiles[fileIndex]) {
          uploadFiles[fileIndex].hashProgress = Number(percentage.toFixed(0))
        }
        if (hash) {
          resolve(hash)
        }
      }
    })
  }

  async function verifyUpload(fileName, fileHash) {
    return new Promise((resolve, reject) => {
      const obj = {
        md5: fileHash,
        fileName
      }
      instance
        .get('fileChunk/presence', { params: obj })
        .then((res) => {
          console.log('verifyUpload -> res', res)
          resolve(res.data)
        })
        .catch((err) => {
          console.log('verifyUpload -> err', err)
          reject(err)
        })
    })
  }

  function isAllStatus() {
    const isAllSuccess = uploadFiles.every((item) =>
      ['success', 'secondPass', 'error'].includes(item.status)
    )
    console.log('mergeRequest -> isAllSuccess', isAllSuccess)
    if (isAllSuccess) {
      status = Status.done
    }
  }
  function getChunkStorage(name) {
    return getObjArr(name)
  }
  function getObjArr(name) {
    // localStorage 获取数组对象的方法
    const res = window.localStorage.getItem(name)
    if (res && res !== 'undefined') {
      return JSON.parse(res)
    }
    return false
  }

  // 切片上传进度
  function createProgresshandler(item) {
    console.log('createProgresshandler -> item', item)
    return (p) => {
      item.progress = parseInt(String((p.loaded / p.total) * 100))
      fileProgress()
    }
  }
  // 文件总进度
  function fileProgress() {
    const currentFile = uploadFiles[fileIndex]
    if (currentFile) {
      const uploadProgress = currentFile.chunkList
        .map((item) => item.size * item.progress)
        .reduce((acc, cur) => acc + cur)
      const currentFileProgress = parseInt(
        (uploadProgress / currentFile.size).toFixed(2)
      )

      // 真假进度条处理--处理进度条后移
      if (!currentFile.fakeUploadProgress) {
        currentFile.uploadProgress = currentFileProgress
      } else if (currentFileProgress > currentFile.fakeUploadProgress) {
        currentFile.uploadProgress = currentFileProgress
      }
    }
  }
  function saveObjArr(name, data) {
    // localStorage 存储数组对象的方法
    localStorage.setItem(name, JSON.stringify(data))
  }
}
