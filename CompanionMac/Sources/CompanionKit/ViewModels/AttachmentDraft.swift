import Foundation
import Combine

@MainActor
public final class AttachmentDraft: ObservableObject {
    @Published public private(set) var item: ComposerImageAttachment?
    @Published public private(set) var isUploading = false
    @Published public private(set) var errorText: String?

    public init() {}

    public func select(_ pending: PendingImageAttachment) {
        item = ComposerImageAttachment(pending: pending, uploaded: nil)
        isUploading = false
        errorText = nil
    }

    public func beginUpload() {
        guard item != nil else { return }
        isUploading = true
        errorText = nil
    }

    public func finishUpload(_ response: MediaUploadResponse, for id: UUID) {
        guard item?.id == id else { return }
        item?.uploaded = response
        isUploading = false
    }

    public func failUpload(_ message: String, for id: UUID) {
        guard item?.id == id else { return }
        isUploading = false
        errorText = message
    }

    public func failSelection(_ message: String) {
        item = nil
        isUploading = false
        errorText = message
    }

    public func remove() {
        item = nil
        isUploading = false
        errorText = nil
    }
}
