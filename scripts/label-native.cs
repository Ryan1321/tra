using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

// A sticker pair is one document page. Let a capable driver repeat that page
// instead of sending the same bitmap and reopening page settings for each copy.
// Never exceed MaximumCopies: Windows may silently truncate the quantity.
public sealed class LabelCopyPlan
{
    public short DriverCopies { get; private set; }
    public int PagesToSend { get; private set; }
    public string Mode { get; private set; }

    public static LabelCopyPlan Create(int copies, int maximumCopies)
    {
        if (copies < 1 || copies > 100) throw new ArgumentOutOfRangeException("copies", "Copies must be from 1 to 100.");
        bool driverRepeats = copies > 1 && maximumCopies >= copies;
        return new LabelCopyPlan {
            DriverCopies = (short)(driverRepeats ? copies : 1),
            PagesToSend = driverRepeats ? 1 : copies,
            Mode = driverRepeats ? "driver-copies" : (copies == 1 ? "single-page" : "repeated-pages")
        };
    }
}

// Scan the existing label pixels without hundreds of thousands of calls
// between PowerShell and System.Drawing. This does not modify the bitmap.
public static class LabelNative
{
    public static RectangleF InkBounds(Bitmap bitmap)
    {
        BitmapData data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height),
            ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            int left = bitmap.Width, top = bitmap.Height, right = 0, bottom = 0;
            byte[] row = new byte[bitmap.Width * 3];
            for (int y = 0; y < bitmap.Height; y++)
            {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                for (int x = 0; x < bitmap.Width; x++)
                {
                    int offset = x * 3;
                    if (row[offset] == 255 && row[offset + 1] == 255 && row[offset + 2] == 255) continue;
                    left = Math.Min(left, x); top = Math.Min(top, y);
                    right = Math.Max(right, x + 1); bottom = Math.Max(bottom, y + 1);
                }
            }
            if (right <= left || bottom <= top) throw new InvalidOperationException("The sticker image is blank.");
            // 300 DPI to the hundredths of an inch used by PrintDocument.
            return new RectangleF(left / 3f, top / 3f, (right - left) / 3f, (bottom - top) / 3f);
        }
        finally { bitmap.UnlockBits(data); }
    }
}
