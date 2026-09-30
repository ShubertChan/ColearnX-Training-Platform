import { useId, useState } from "react";
import { courseAssetApi } from "../../api/uploads";
import { isVideoSource, VIDEO_UPLOAD_ACCEPT } from "../../utils/videoUpload";
import CourseVideoUploader from "./CourseVideoUploader";
import PrivateAssetUploader from "./PrivateAssetUploader";
import UploadDropzone from "./UploadDropzone";

function CourseUploadPicker({ video, disabled }) {
  const [error, setError] = useState("");
  const id = useId();
  const addFiles = files => {
    if (video.disabled) return;
    const selected = Array.from(files || []);
    setError("");
    if (!selected.length) return;
    if (selected.length > 1) { setError("Choose one main course video at a time."); return; }
    if (!isVideoSource(selected[0])) { setError("Video courses only accept non-empty video files. Choose a video file."); return; }
    video.chooseFile(selected[0]);
  };
  return <div className="course-upload-picker">
    <p id={`${id}-purpose`} className="course-upload-guidance">{video.active
      ? "Uploading your main course video. Follow progress or pause the upload above."
      : video.resuming
      ? "Select the exact original video to resume the paused upload."
      : "Upload the main course video here. Video files only; it must finish processing before you can submit for review."}</p>
    {video.disabled && !disabled && !video.active && <p role="status">{video.loading ? "Checking video status…"
      : video.processing ? "Your video is processing. You can submit for review once it is ready."
      : "Another main video cannot be uploaded right now. Check the video status above or refresh it."}</p>}
    <UploadDropzone onFiles={addFiles} disabled={video.disabled} multiple={false}
      title="Drop video here" buttonLabel="Choose video"
      inputLabel={video.resuming ? "Choose original video to resume" : "Choose course video"}
      accept={VIDEO_UPLOAD_ACCEPT}
      hint="One video · up to 4 hours · duration verified after processing"
      describedBy={`${id}-purpose${error ? ` ${id}-error` : ""}`} />
    {error && <p id={`${id}-error`} role="alert" className="form-error">{error}</p>}
  </div>;
}

export default function CourseFilesUploader({ courseId, disabled, onVideoChange, onAssetsChange }) {
  // Retain inventory/removal for older attachments and their review guards,
  // but route every new selection or drop through the main-video uploader.
  return <CourseVideoUploader courseId={courseId} disabled={disabled} onStateChange={onVideoChange}
    renderUploadArea={video => <PrivateAssetUploader contentVersionId={courseId} assetApi={courseAssetApi}
      label="Course files" disabled={disabled} onAssetsChange={onAssetsChange}
      renderPicker={() => <CourseUploadPicker video={video} disabled={disabled} />} />} />;
}
